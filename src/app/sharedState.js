'use strict';
// Atlas frontend — cross-module mutable state (PR-09b).
// Foreign-written top-level lets can't be shared as ES imported bindings
// (imports are read-only), so they live on this single mutable object.
// TODO(PR-10/PR-11): fold these into the state store with the rest.
export const sharedState = {
  atlasLastError: null,
  historyLoaded: false,
};
