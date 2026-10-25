![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

# Parkii Agent

Find camera-observed street parking in covered San Francisco locations directly
inside ASI:One. Nova hosts the live demo agent at:

`agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq`

## Try it

- `help`
- `find me parking near the Castro Theatre`
- `parking near Harvey Milk Plaza`

The agent resolves your destination, asks the shared Convex parking service for
a fresh available stall, creates the same three-minute application hold used by
the web app, looks up street-cleaning rules, and replies with processed age,
detection agreement, camera links when available, and directions.

The current demo uses explicit nearest-spot selection without a language-model
call. DataSF rules run in-process; remote Rules-Agent messaging, Apify and Elastic
are not claimed as verified live. A shared camera-page link may be returned when
the public backend omits an individual video source. It is not a detection frame.

The hold hides a spot from other Parkii users; it does not reserve public curb
space. Anyone may still occupy it. Coverage, camera lag and calibration limit
availability; check the curb and signs yourself. When no eligible spot exists,
the agent reports no availability instead of inventing one.

Run/test instructions and current evidence: [repository](https://github.com/nathanleung0/parksight)
and `agents/DEMO_RUNBOOK.md`. A new chat test is not a completed hackathon submission.
