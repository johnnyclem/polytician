/// PolyVault canister types for chunk/commit storage.
/// Matches the TypeScript ChunkSchema / CommitSchema contracts.

module {

  public type TimestampMs = Nat64;
  public type PrincipalText = Text;
  public type HashHex = Text;

  public type ChunkKey = {
    bundleId : Text;
    chunkIndex : Nat32;
  };

  public type ChunkRecord = {
    version : Text;
    bundleId : Text;
    commitId : Text;
    chunkIndex : Nat32;
    chunkCount : Nat32;
    chunkHash : HashHex;
    compressed : Bool;
    encrypted : Bool;
    payload : Blob;
    createdAtMs : TimestampMs;
  };

  public type CommitRecord = {
    commitId : Text;
    parentCommitId : ?Text;
    dedupeKey : Text;
    authorPrincipal : Principal;
    createdAtMs : TimestampMs;
    chunkCount : Nat32;
    manifestHash : HashHex;
  };

  public type PutChunkRequest = {
    idempotencyKey : Text;
    commitId : Text;
    bundleId : Text;
    chunkIndex : Nat32;
    chunkCount : Nat32;
    chunkHash : HashHex;
    compressed : Bool;
    encrypted : Bool;
    payload : Blob;
  };

  public type FinalizeCommitRequest = {
    commitId : Text;
    parentCommitId : ?Text;
    dedupeKey : Text;
    manifestHash : HashHex;
    expectedChunkCount : Nat32;
  };

  public type FinalizeCommitResponse = {
    accepted : Bool;
    duplicateOf : ?Text;
  };

  public type CommitListResult = {
    commits : [CommitRecord];
    nextCursor : ?Text;
  };

  public type ChunkListResult = {
    chunks : [ChunkRecord];
    nextOffset : ?Nat32;
  };
};
