## Focus: CI/CD and Test Failures

When investigating failures:
1. Check the CI log for the first failing test or build error
2. Bisect: find the commit that introduced the failure
3. Reproduce locally before proposing a fix
4. Prefer minimal fixes that unblock CI over refactors

Report format: failing test → root cause → minimal fix → verification command.
