// @ts-check
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// Server-rendered rather than static: the sign-in email and sign-out
	// button both depend on reading the ALB's per-request auth header, which
	// a statically built page can never see.
	output: 'server',
	adapter: node({
		mode: 'standalone',
	}),
	// Trust the ALB's forwarded headers for all subdomains
	security: {
		allowedDomains: [
			{
				hostname: '**.i.ai.gov.uk',
				protocol: 'https'
			}
		]
	},
	vite: {
		css: {
			lightningcss: {
				// GOV.UK Frontend still ships a legacy `@media (min-width: 0\0)`
				// IE hack that LightningCSS otherwise fails to parse.
				errorRecovery: true,
			},
		},
	},
});
