# QUEST_GENERATION_RUNTIME_REPORT

## Summary

This report traces the actual UI flow for "Generate Quest" from the frontend click event through auth, backend generation, and on-chain registration.

## Frontend trace

1. `frontend/src/pages/CommandCenter.tsx`
   - `handleGenerateQuest()` is invoked by the Generate button.
   - It verifies wallet connection and readiness.
   - It calls `requireReadyAuth('generating quests')`.
     - This restores the auth session, or prompts wallet signature if needed.
   - On success, it calls `generateQuest('Celo')`.
   - It then performs the on-chain `createQuest` transaction and registers the quest via `registerOnchainQuest()`.

2. `frontend/src/lib/api.ts`
   - `generateQuest()` sends `POST /quests/generate` through the shared `api` Axios client.
   - `api` is configured with:
     - `baseURL` from `env.API_BASE_URL`
     - `withCredentials: true`
     - `Authorization: Bearer <accessToken>` when the session is active
   - A 401 response triggers `restoreAuthSession()` and retries the request.

3. `frontend/src/lib/env.ts`
   - `VITE_API_BASE_URL` is required in production.
   - In development, missing value defaults to `http://localhost:4000/api`.
   - Current `.env` points at `https://questforge-ai-production.up.railway.app/api`.

## Backend trace

1. `backend/src/routes/api.ts`
   - `POST /api/quests/generate` is protected by `requireAuth`.
   - `POST /api/quests/register-onchain` is also protected.

2. `backend/src/controllers/questController.ts`
   - `generateQuest()` ensures the user is authenticated and has daily generation capacity.
   - It generates the quest, upserts it in the database, and returns the quest template payload.

## Likely runtime breakpoints

- `frontend/.env` is configured to use the production Railway backend.
  - If local frontend testing is intended, the UI may be calling a different backend than the local API tests.
- The UI flow depends on cross-origin auth cookies and refresh token handling:
  - `refreshClient` uses `withCredentials: true`.
  - The backend must allow credentials and set cookies with `SameSite=None` and `Secure`.
- If auth restore fails, `handleGenerateQuest()` will return early and the user will see a session message rather than the quest flow.

## Changes applied

- Added runtime debug logging in `frontend/src/pages/CommandCenter.tsx` for:
  - `handleGenerateQuest()` start conditions
  - auth readiness state
  - API base URL
  - request success/failure details
- Added debug metadata logging in `frontend/src/lib/api.ts` for `generateQuest()`.

## Next verification steps

1. Reproduce the UI flow in a browser with developer tools open.
2. Confirm the exact request URL for `/quests/generate` and `/auth/refresh`.
3. Verify the request is using the expected `API_BASE_URL` and includes credentials.
4. Check the backend response status and any CORS or cookie errors.
5. If testing locally, switch `VITE_API_BASE_URL` to `http://localhost:4000/api` or use a matching local backend.
6. Confirm `AUTH_COOKIE_SAME_SITE=none` and `AUTH_COOKIE_SECURE=true` on the deployed backend if frontend and backend are different origins.

## Conclusion

At present, the frontend click path is implemented correctly. The most likely issue remains environment/runtime configuration:

- backend URL mismatch between local tests and frontend runtime
- cross-origin credential/cookie auth for session refresh
- auth session restore failure before `POST /api/quests/generate`
