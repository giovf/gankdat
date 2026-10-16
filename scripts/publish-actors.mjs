#!/usr/bin/env node
// CI: push every Apify actor whose folder changed in this push (or all with --all; none with
// PUBLISH_ONLY=1, used by the daily schedule), then make sure each actor on the account is priced
// (pay-per-event `result`, US$0.001) and public. Apify support (2026-09-28): publishing is limited
// to 5 Actor publications per organisation per 24 h and `cannot-publish-actor` means that limit
// is hit — so at most MAX_PUBLISH_PER_RUN actors are made public per run, the run stops at the
// first refusal, and the workflow also runs daily. Needs APIFY_TOKEN and GANKDAT_INTERNAL_API_KEY.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const token = process.env.APIFY_TOKEN;
const serviceKey = process.env.GANKDAT_INTERNAL_API_KEY;
if (!token || !serviceKey) {
  console.error('APIFY_TOKEN / GANKDAT_INTERNAL_API_KEY missing');
  process.exit(1);
}
const root = 'ventures/gankdat/apify';
const all = process.argv.includes('--all');
const MAX_PUBLISH_PER_RUN = 5;
let published = 0;
let rateLimited = false;
// `github.event.before..sha` needs both ends locally — the workflow checks out full depth since
// 2026-09-30 (depth 2 could not see a two-commit push). An unresolvable range (branch creation,
// force-push) falls back to the last commit instead of crashing before any actor is priced.
const wanted = process.env.DIFF_RANGE ?? 'HEAD~1..HEAD';
const resolvable = (r) => {
  try {
    execSync(`git rev-list --max-count=1 ${r}`, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const range = resolvable(wanted) ? wanted : 'HEAD~1..HEAD';
if (range !== wanted) console.log(`range ${wanted} not resolvable here — using ${range}`);
const changed = process.env.PUBLISH_ONLY
  ? []
  : all
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [
        ...new Set(
          execSync(`git diff --name-only ${range} -- ${root}`, { encoding: 'utf8' })
            .split('\n')
            .map((p) => p.split('/')[3])
            .filter(Boolean),
        ),
      ];
const sh = (cmd, opts = {}) =>
  execSync(cmd, {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, APIFY_DISABLE_KEYRING: '1' },
    ...opts,
  });
sh(`npx --yes apify-cli@latest login --token "${token}"`);
sh(`npx apify-cli secrets add gankdatApiKey "${serviceKey}" || true`);
for (const dir of changed) {
  if (!existsSync(`${root}/${dir}/.actor/actor.json`)) continue;
  const out = sh('npx apify-cli push --wait-for-finish 900 --force', { cwd: `${root}/${dir}` });
  const build = /^Build: (\w+)/m.exec(out)?.[1] ?? 'unknown';
  console.log(`${dir}: build ${build}`);
  if (build !== 'SUCCEEDED') process.exitCode = 1;
}
// Pricing + publication for every actor on the account.
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const acts = (
  await (await fetch('https://api.apify.com/v2/acts?my=true&limit=100', { headers: H })).json()
).data.items;
for (const a of acts) {
  const g = (await (await fetch(`https://api.apify.com/v2/acts/${a.id}`, { headers: H })).json())
    .data;
  const body = {};
  if (!g.pricingInfos?.length) {
    body.pricingInfos = [
      {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: {
          actorChargeEvents: {
            result: {
              eventTitle: 'Result (one record)',
              eventDescription: 'One record written to the dataset',
              eventPriceUsd: 0.001,
            },
          },
        },
      },
    ];
    body.categories = ['LEAD_GENERATION', 'BUSINESS'];
    body.seoTitle = (g.seoTitle ?? g.title ?? '').slice(0, 60);
    body.seoDescription = (g.seoDescription ?? g.description ?? '').slice(0, 160);
  }
  if (!g.isPublic && !rateLimited && published < MAX_PUBLISH_PER_RUN) body.isPublic = true;
  if (Object.keys(body).length === 0) {
    console.log(`${g.name}: priced, public`);
    continue;
  }
  const put = async () =>
    (
      await fetch(`https://api.apify.com/v2/acts/${a.id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify(body),
      })
    ).json();
  let j = await put();
  if (j.error?.type === 'tagged-build-required') {
    // No build carries the `latest` tag (an aborted push leaves the actor like this): build the
    // latest version, tag it, and retry once.
    const version = g.versions?.at(-1)?.versionNumber ?? '0.1';
    const b = await (
      await fetch(
        `https://api.apify.com/v2/acts/${a.id}/builds?version=${version}&tag=latest&waitForFinish=300`,
        { method: 'POST', headers: H },
      )
    ).json();
    console.log(`${g.name}: build ${b.data?.status ?? 'ERR ' + b.error?.type}`);
    if (b.data?.status === 'SUCCEEDED') j = await put();
  }
  if (j.error?.type === 'cannot-publish-actor' && body.isPublic) {
    rateLimited = true;
    delete body.isPublic;
    const r2 = Object.keys(body).length
      ? await fetch(`https://api.apify.com/v2/acts/${a.id}`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify(body),
        })
      : { ok: true };
    console.log(
      `${g.name}: publish refused (5 publications / 24 h limit reached; the daily run continues tomorrow)${Object.keys(body).length ? `; pricing ${r2.ok ? 'set' : 'failed'}` : ''}`,
    );
    continue;
  }
  if (body.isPublic && !j.error) published += 1;
  console.log(
    `${g.name}: ${j.error ? 'ERR ' + j.error.type : 'updated (' + Object.keys(body).join(', ') + ')'}`,
  );
}
console.log(`published this run: ${published}${rateLimited ? ' (daily limit reached)' : ''}`);
