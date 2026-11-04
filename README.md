# AI Gateway Frontend

The web console for the i.AI Gateway — a self-service front end over a [LiteLLM](https://github.com/BerriAI/litellm) proxy. Users sign in, browse the available models, generate and manage their own API keys, and view their usage, cost and environmental-impact trends.

It is a server-rendered [Astro](https://astro.build) app: the sign-in email and sign-out button both depend on reading the ALB's per-request auth header, which a statically built page can never see.

## Requirements

- Node.js >= 22.23.4
- npm

## Getting started

This repo holds the frontend application and its build/deploy plumbing. It was migrated out of [i-dot-ai/core-llm-gateway](https://github.com/i-dot-ai/core-llm-gateway), which still owns the gateway backend.

```sh
cp .env.example .env
npm install
npm run dev
```

See `.env.example` for supported variables and what each one does.

## Testing against a real LiteLLM

`compose.yaml` runs a real [LiteLLM](https://github.com/BerriAI/litellm) proxy with the Postgres it needs for keys, teams and spend. Its models use `mock_response`, so no provider keys are required. Use this instead of `npm run mock:litellm` when you want real key/team/spend behaviour rather than canned fixtures.

```sh
docker compose up -d

# Point .env at it:
#   LITELLM_URL=http://localhost:4000
#   LITELLM_MASTER_KEY=sk-local-dev

# Seed the "personal" team that key generation needs (once):
curl -X POST http://localhost:4000/team/new \
  -H "Authorization: Bearer sk-local-dev" -H "Content-Type: application/json" \
  -d '{"team_alias":"personal"}'

npm run dev
```

## Deployment

The app builds to a standalone Node server (`@astrojs/node`), started with `node ./dist/server/entry.mjs`. The included `Dockerfile` packages that bundle.

In production it sits behind an AWS ALB that performs OIDC authentication and forwards the identity in the `x-amzn-oidc-data` header, which `src/middleware.ts` validates against the auth API.

The image is only built, tagged and pushed to ECR when a GitHub Release is published (`.github/workflows/release.yml`). Merging to `main` or pushing commits does not publish an image. Each release tags it with the version (`1.2.3`, `1.2`, `1`), the full commit hash (`sha-<commit>`) and, for non-prereleases, `latest`.

> Some deployment details in this repo — gateway hostnames, Slack channels and
> internal repository links — are specific to the i.AI environment. Adjust them
> for your own deployment.

## License

[MIT](LICENSE)
