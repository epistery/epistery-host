/**
 * Supplying a git credential without writing it down.
 *
 * The obvious ways to authenticate a git command all persist the secret
 * somewhere it outlives the command:
 *
 *   - `https://x-access-token:TOKEN@host/org/repo` — git stores the URL, token
 *     and all, in the clone's .git/config. Rotate the PAT and every existing
 *     clone keeps fetching with the dead one, failing with a bare exit 128 that
 *     names nothing. That is precisely how registry broke.
 *   - `-c http.extraheader=Authorization: ...` — the token lands in the process
 *     arguments, readable by any user on the box via `ps`.
 *
 * So the token goes in the ENVIRONMENT, and git is given a credential helper
 * that reads it from there. The helper string in argv contains the literal
 * `$EPISTERY_GIT_TOKEN` — git runs helpers through a shell, which expands it at
 * call time. Nothing is written to disk and nothing appears in argv.
 *
 * Both the install (clone) and update (fetch) paths use this, from here, so a
 * change to one cannot silently diverge from the other.
 */

export const GIT_TOKEN_ENV = 'EPISTERY_GIT_TOKEN';

/**
 * Build the git arguments and environment that authenticate one command.
 * With no token, both are empty and the command runs unauthenticated.
 *
 * @param {string|null} token
 * @returns {{args: string[], env: Record<string,string>}}
 */
export function gitCredential(token) {
  if (!token) return { args: [], env: {} };
  return {
    // The empty value resets git's helper list first, so a helper configured
    // system- or user-wide cannot answer ahead of ours with a stale credential.
    args: [
      '-c', 'credential.helper=',
      '-c', `credential.helper=!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`
    ],
    env: { [GIT_TOKEN_ENV]: token }
  };
}
