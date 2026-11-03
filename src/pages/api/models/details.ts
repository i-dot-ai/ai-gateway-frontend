/**
 * GET /api/models/details - the cached provider-page extractions (keyed by uri)
 * and Arena rankings (keyed by model name), for inspection and the search eval.
 *
 * Behind the normal sign-in like every other page. Not for the UI: the pages
 * read the caches directly. The payload is one entry per configured model,
 * so it grows with config.yml, not with usage. Remove once the eval reads the
 * cache through a test hook instead.
 */
import type { APIRoute } from 'astro';
import { arenaRankings } from '../../../lib/arena';
import { getAllModels } from '../../../lib/litellm';
import { allModelDetails } from '../../../lib/modelDetails';

export const GET: APIRoute = async () => {
	const all = await getAllModels();
	const arena = Object.fromEntries(all.models.map((m) => [m.name, arenaRankings(m)]).filter(([, r]) => r.length > 0));
	return new Response(JSON.stringify({ details: allModelDetails(), arena }, null, 2), { headers: { 'Content-Type': 'application/json' } });
};
