/// PolyVault access control module.
/// Manages owner principal, write allowlist, and read allowlist
/// for canister method authorization.

import Array "mo:base/Array";
import Principal "mo:base/Principal";
import Buffer "mo:base/Buffer";

module {

  public type AuthError = {
    #unauthorized : Text;
  };

  public class AccessControl(initialOwner : Principal) {
    var owner : Principal = initialOwner;
    var writeAllowlist : [Principal] = [];
    var readAllowlist : [Principal] = [];

    /// Check if the caller is the owner.
    public func isOwner(caller : Principal) : Bool {
      caller == owner;
    };

    /// Check if the caller is authorized to write (owner or on write allowlist).
    public func isWriter(caller : Principal) : Bool {
      if (caller == owner) { return true };
      for (p in writeAllowlist.vals()) {
        if (p == caller) { return true };
      };
      false;
    };

    /// Check if the caller is authorized to read (owner or on read allowlist).
    public func isReader(caller : Principal) : Bool {
      if (caller == owner) { return true };
      for (p in readAllowlist.vals()) {
        if (p == caller) { return true };
      };
      false;
    };

    /// Set the write allowlist. Only the owner may call this.
    public func setWriteAllowlist(caller : Principal, principals : [Principal]) : Bool {
      if (caller != owner) { return false };
      writeAllowlist := principals;
      true;
    };

    /// Set the read allowlist. Only the owner may call this.
    public func setReadAllowlist(caller : Principal, principals : [Principal]) : Bool {
      if (caller != owner) { return false };
      readAllowlist := principals;
      true;
    };

    /// Get the current write allowlist.
    public func getWriteAllowlist() : [Principal] {
      writeAllowlist;
    };

    /// Get the current read allowlist.
    public func getReadAllowlist() : [Principal] {
      readAllowlist;
    };

    /// Get the owner principal.
    public func getOwner() : Principal {
      owner;
    };
  };
};
