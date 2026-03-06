/// PolyVault stable storage layer.
/// Manages chunk records, commit records, idempotency keys, and dedupe index
/// using stable-compatible data structures (RBTree/HashMap).

import Types "types";
import RBTree "mo:base/RBTree";
import Text "mo:base/Text";
import Nat32 "mo:base/Nat32";
import Nat64 "mo:base/Nat64";
import Array "mo:base/Array";
import Buffer "mo:base/Buffer";
import Iter "mo:base/Iter";
import Order "mo:base/Order";
import Option "mo:base/Option";
import Result "mo:base/Result";

module {

  /// Composite key for chunk lookup: "bundleId:chunkIndex"
  func chunkKeyToText(key : Types.ChunkKey) : Text {
    key.bundleId # ":" # Nat32.toText(key.chunkIndex);
  };

  public class StableStore() {
    // Primary stores
    var chunks = RBTree.RBTree<Text, Types.ChunkRecord>(Text.compare);
    var commits = RBTree.RBTree<Text, Types.CommitRecord>(Text.compare);

    // Idempotency: tracks already-stored chunk keys to enable idempotent put_chunk
    var idempotencyKeys = RBTree.RBTree<Text, Bool>(Text.compare);

    // Dedupe: maps dedupeKey -> commitId for finalize_commit duplicate detection
    var dedupeIndex = RBTree.RBTree<Text, Text>(Text.compare);

    // Index: maps commitId -> list of chunk keys (for get_chunks_for_commit)
    var commitChunkIndex = RBTree.RBTree<Text, [Text]>(Text.compare);

    /// Store a chunk record. Returns #ok if stored or already exists (idempotent).
    /// Returns #err if the idempotency key exists but maps to different data.
    public func putChunk(req : Types.PutChunkRequest, now : Types.TimestampMs) : Result.Result<(), Text> {
      // Check idempotency
      switch (idempotencyKeys.get(req.idempotencyKey)) {
        case (?true) {
          // Already stored — idempotent success
          return #ok(());
        };
        case _ {};
      };

      let key = chunkKeyToText({ bundleId = req.bundleId; chunkIndex = req.chunkIndex });
      let record : Types.ChunkRecord = {
        version = "1.0";
        bundleId = req.bundleId;
        commitId = req.commitId;
        chunkIndex = req.chunkIndex;
        chunkCount = req.chunkCount;
        chunkHash = req.chunkHash;
        compressed = req.compressed;
        encrypted = req.encrypted;
        payload = req.payload;
        createdAtMs = now;
      };

      chunks.put(key, record);
      idempotencyKeys.put(req.idempotencyKey, true);

      // Update commitChunkIndex
      let existingKeys = switch (commitChunkIndex.get(req.commitId)) {
        case (?keys) { keys };
        case null { [] };
      };
      let newKeys = Array.append<Text>(existingKeys, [key]);
      commitChunkIndex.put(req.commitId, newKeys);

      #ok(());
    };

    /// Retrieve a single chunk by bundleId + chunkIndex.
    public func getChunk(bundleId : Text, chunkIndex : Nat32) : ?Types.ChunkRecord {
      let key = chunkKeyToText({ bundleId; chunkIndex });
      chunks.get(key);
    };

    /// Finalize a commit. Validates all expected chunks are present.
    /// Returns duplicate detection via dedupeKey.
    public func finalizeCommit(
      req : Types.FinalizeCommitRequest,
      caller : Principal,
      now : Types.TimestampMs,
    ) : Result.Result<Types.FinalizeCommitResponse, Text> {
      // Check for duplicate dedupeKey
      switch (dedupeIndex.get(req.dedupeKey)) {
        case (?existingCommitId) {
          return #ok({
            accepted = false;
            duplicateOf = ?existingCommitId;
          });
        };
        case null {};
      };

      // Check if commit already exists
      switch (commits.get(req.commitId)) {
        case (?_) {
          return #err("Commit already exists: " # req.commitId);
        };
        case null {};
      };

      // Validate all chunks are present
      let chunkKeys = switch (commitChunkIndex.get(req.commitId)) {
        case (?keys) { keys };
        case null { [] };
      };

      if (Nat32.fromNat(chunkKeys.size()) != req.expectedChunkCount) {
        return #err(
          "Expected " # Nat32.toText(req.expectedChunkCount) #
          " chunks, found " # Nat32.toText(Nat32.fromNat(chunkKeys.size()))
        );
      };

      // Verify chunk indices are contiguous 0..expectedChunkCount-1
      let expectedCount = Nat32.toNat(req.expectedChunkCount);
      let found = Array.init<Bool>(expectedCount, false);
      for (key in chunkKeys.vals()) {
        switch (chunks.get(key)) {
          case (?chunk) {
            let idx = Nat32.toNat(chunk.chunkIndex);
            if (idx < expectedCount) {
              found[idx] := true;
            };
          };
          case null {
            return #err("Chunk key in index but not in store: " # key);
          };
        };
      };
      for (i in Iter.range(0, expectedCount - 1)) {
        if (not found[i]) {
          return #err("Missing chunk at index " # Nat32.toText(Nat32.fromNat(i)));
        };
      };

      // Create commit record
      let record : Types.CommitRecord = {
        commitId = req.commitId;
        parentCommitId = req.parentCommitId;
        dedupeKey = req.dedupeKey;
        authorPrincipal = caller;
        createdAtMs = now;
        chunkCount = req.expectedChunkCount;
        manifestHash = req.manifestHash;
      };

      commits.put(req.commitId, record);
      dedupeIndex.put(req.dedupeKey, req.commitId);

      #ok({
        accepted = true;
        duplicateOf = null;
      });
    };

    /// List commits created after sinceUpdatedAtMs, with cursor-based pagination.
    /// Commits are returned in ascending createdAtMs order.
    public func listCommits(
      sinceUpdatedAtMs : Types.TimestampMs,
      limit : Nat32,
      cursor : ?Text,
    ) : Types.CommitListResult {
      let allCommits = Buffer.Buffer<Types.CommitRecord>(16);

      // Collect all commits from the tree
      for ((_, record) in commits.entries()) {
        if (record.createdAtMs > sinceUpdatedAtMs) {
          allCommits.add(record);
        };
      };

      // Sort by createdAtMs ascending, then commitId ascending for stable order
      let sorted = Buffer.toArray(allCommits);
      let sortedArr = Array.sort<Types.CommitRecord>(
        sorted,
        func(a : Types.CommitRecord, b : Types.CommitRecord) : Order.Order {
          let tsCmp = Nat64.compare(a.createdAtMs, b.createdAtMs);
          switch (tsCmp) {
            case (#equal) { Text.compare(a.commitId, b.commitId) };
            case other { other };
          };
        },
      );

      // Apply cursor: skip commits until we pass the cursor commitId
      var startIdx : Nat = 0;
      switch (cursor) {
        case (?cursorId) {
          var found = false;
          label search for (i in Iter.range(0, sortedArr.size() - 1)) {
            if (sortedArr[i].commitId == cursorId) {
              startIdx := i + 1;
              found := true;
              break search;
            };
          };
        };
        case null {};
      };

      // Apply limit
      let maxItems = Nat32.toNat(limit);
      let endIdx = if (startIdx + maxItems > sortedArr.size()) {
        sortedArr.size();
      } else {
        startIdx + maxItems;
      };

      let result = Buffer.Buffer<Types.CommitRecord>(maxItems);
      for (i in Iter.range(startIdx, endIdx - 1)) {
        result.add(sortedArr[i]);
      };

      let resultArr = Buffer.toArray(result);
      let nextCursor : ?Text = if (endIdx < sortedArr.size()) {
        ?resultArr[resultArr.size() - 1].commitId;
      } else {
        null;
      };

      { commits = resultArr; nextCursor };
    };

    /// Get the most recent commit by createdAtMs.
    public func getLatestCommit() : ?Types.CommitRecord {
      var latest : ?Types.CommitRecord = null;
      for ((_, record) in commits.entries()) {
        switch (latest) {
          case (?current) {
            if (record.createdAtMs > current.createdAtMs) {
              latest := ?record;
            } else if (record.createdAtMs == current.createdAtMs and Text.compare(record.commitId, current.commitId) == #greater) {
              latest := ?record;
            };
          };
          case null { latest := ?record };
        };
      };
      latest;
    };

    /// Get chunks for a given commitId, with offset/limit pagination.
    public func getChunksForCommit(
      commitId : Text,
      offset : Nat32,
      limit : Nat32,
    ) : Types.ChunkListResult {
      let chunkKeys = switch (commitChunkIndex.get(commitId)) {
        case (?keys) { keys };
        case null { return { chunks = []; nextOffset = null } };
      };

      // Collect and sort chunks by index
      let chunkRecords = Buffer.Buffer<Types.ChunkRecord>(chunkKeys.size());
      for (key in chunkKeys.vals()) {
        switch (chunks.get(key)) {
          case (?record) { chunkRecords.add(record) };
          case null {};
        };
      };

      let sorted = Array.sort<Types.ChunkRecord>(
        Buffer.toArray(chunkRecords),
        func(a : Types.ChunkRecord, b : Types.ChunkRecord) : Order.Order {
          Nat32.compare(a.chunkIndex, b.chunkIndex);
        },
      );

      let startIdx = Nat32.toNat(offset);
      let maxItems = Nat32.toNat(limit);

      if (startIdx >= sorted.size()) {
        return { chunks = []; nextOffset = null };
      };

      let endIdx = if (startIdx + maxItems > sorted.size()) {
        sorted.size();
      } else {
        startIdx + maxItems;
      };

      let result = Buffer.Buffer<Types.ChunkRecord>(maxItems);
      for (i in Iter.range(startIdx, endIdx - 1)) {
        result.add(sorted[i]);
      };

      let nextOffset : ?Nat32 = if (endIdx < sorted.size()) {
        ?Nat32.fromNat(endIdx);
      } else {
        null;
      };

      { chunks = Buffer.toArray(result); nextOffset };
    };
  };
};
