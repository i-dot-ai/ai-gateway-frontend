import type { APIRoute } from "astro";
import { getAllModels } from "../lib/litellm";
import { buildOpencodeConfig } from "../lib/opencode";

// An always-current opencode.json built from the live model list, so users set
// up OpenCode from the gateway's actual models rather than a file maintained by
// hand in a separate repo. The config carries no secrets - OpenCode's /connect
// flow adds the user's key separately - so it's safe to hand out as-is.
export const GET: APIRoute = async () => {
	const { models, error } = await getAllModels();
	if (error !== undefined) {
		return new Response(error, { status: 502 });
	}

	const config = buildOpencodeConfig(models);

	return new Response(JSON.stringify(config, null, 2), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="opencode.json"`,
		},
	});
};
