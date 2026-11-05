-- BizCost: the closed beta, after its catalog checks: a trigger function runs as its trigger fires and
-- is executable by nobody else (as tenancy_security says of every one), and the limit on upload URLs
-- needs no more than the caller's own rows, which its RLS already shows it. See D-356.

revoke all on function app.guard_feedback() from public, anon, authenticated;
revoke all on function app.feedback_upload_limits() from public, anon, authenticated;

alter function app.feedback_upload_limits() security invoker;
