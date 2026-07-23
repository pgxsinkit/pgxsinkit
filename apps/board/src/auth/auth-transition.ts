/**
 * Orders asynchronous signed-out navigation against newer auth events. A transition may finish only
 * while its epoch is still current; accepting a newer authenticated session invalidates the old epoch.
 */
export function createAuthTransitionCoordinator() {
  let epoch = 0;
  let signingOut = false;

  return {
    acceptAuthenticated(): void {
      epoch += 1;
      signingOut = false;
    },
    beginSignedOut(): number | null {
      if (signingOut) return null;
      signingOut = true;
      epoch += 1;
      return epoch;
    },
    completeSignedOut(transitionEpoch: number): boolean {
      if (!signingOut || transitionEpoch !== epoch) return false;
      signingOut = false;
      return true;
    },
    invalidate(): void {
      epoch += 1;
      signingOut = false;
    },
  };
}
