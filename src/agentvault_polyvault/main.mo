/// PolyVault canister — chunk/commit storage for ThoughtForm backup/sync.
/// Exposes put_chunk, get_chunk, finalize_commit, list_commits,
/// get_latest_commit, and get_chunks_for_commit.

import Types "types";
import Auth "auth";
import StableStore "stable_store";
import Result "mo:base/Result";
import Time "mo:base/Time";
import Int "mo:base/Int";
import Nat64 "mo:base/Nat64";

actor PolyVault {

  // --- Stable state ---

  stable var owner : Principal = __installing_principal;
  let store = StableStore.StableStore();
  let access = Auth.AccessControl(owner);

  // --- Helpers ---

  func nowMs() : Types.TimestampMs {
    let ns = Time.now();
    let ms = ns / 1_000_000;
    Nat64.fromNat(Int.abs(ms));
  };

  // --- Public API ---

  /// Store a chunk. Idempotent: repeated calls with the same idempotencyKey succeed without duplication.
  public shared (msg) func put_chunk(req : Types.PutChunkRequest) : async Result.Result<(), Text> {
    if (not access.isWriter(msg.caller)) {
      return #err("Unauthorized: caller is not permitted to write");
    };
    store.putChunk(req, nowMs());
  };

  /// Retrieve a single chunk by bundleId and chunkIndex.
  public shared query (msg) func get_chunk(bundleId : Text, chunkIndex : Nat32) : async ?Types.ChunkRecord {
    if (not access.isReader(msg.caller)) { return null };
    store.getChunk(bundleId, chunkIndex);
  };

  /// Finalize a commit after all chunks have been uploaded.
  /// Validates that all expected chunks are present.
  /// Returns duplicate detection via dedupeKey.
  public shared (msg) func finalize_commit(
    commitId : Text,
    parentCommitId : ?Text,
    dedupeKey : Text,
    manifestHash : Types.HashHex,
    expectedChunkCount : Nat32,
  ) : async Result.Result<Types.FinalizeCommitResponse, Text> {
    if (not access.isWriter(msg.caller)) {
      return #err("Unauthorized: caller is not permitted to write");
    };
    let req : Types.FinalizeCommitRequest = {
      commitId;
      parentCommitId;
      dedupeKey;
      manifestHash;
      expectedChunkCount;
    };
    store.finalizeCommit(req, msg.caller, nowMs());
  };

  /// List commits created after sinceUpdatedAtMs, with cursor-based pagination.
  public shared query (msg) func list_commits(
    sinceUpdatedAtMs : Types.TimestampMs,
    limit : Nat32,
    cursor : ?Text,
  ) : async Types.CommitListResult {
    if (not access.isReader(msg.caller)) {
      return { commits = []; nextCursor = null };
    };
    store.listCommits(sinceUpdatedAtMs, limit, cursor);
  };

  /// Get the most recent commit.
  public shared query (msg) func get_latest_commit() : async ?Types.CommitRecord {
    if (not access.isReader(msg.caller)) { return null };
    store.getLatestCommit();
  };

  /// Get chunks belonging to a specific commit, with offset/limit pagination.
  public shared query (msg) func get_chunks_for_commit(
    commitId : Text,
    offset : Nat32,
    limit : Nat32,
  ) : async Types.ChunkListResult {
    if (not access.isReader(msg.caller)) {
      return { chunks = []; nextOffset = null };
    };
    store.getChunksForCommit(commitId, offset, limit);
  };

  // --- Access control management ---

  /// Set the write allowlist. Only the owner may call this.
  public shared (msg) func set_allowlist(principals : [Principal]) : async Result.Result<(), Text> {
    if (not access.setWriteAllowlist(msg.caller, principals)) {
      return #err("Unauthorized: only the owner can set the allowlist");
    };
    #ok(());
  };

  /// Get the current write allowlist.
  public shared query (msg) func get_allowlist() : async [Principal] {
    if (not access.isOwner(msg.caller)) { return [] };
    access.getWriteAllowlist();
  };

  /// Set the read allowlist. Only the owner may call this.
  public shared (msg) func set_read_allowlist(principals : [Principal]) : async Result.Result<(), Text> {
    if (not access.setReadAllowlist(msg.caller, principals)) {
      return #err("Unauthorized: only the owner can set the read allowlist");
    };
    #ok(());
  };

  /// Get the current read allowlist.
  public shared query (msg) func get_read_allowlist() : async [Principal] {
    if (not access.isOwner(msg.caller)) { return [] };
    access.getReadAllowlist();
  };
};
