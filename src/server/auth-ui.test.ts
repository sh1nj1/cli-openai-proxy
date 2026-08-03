import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { resetCapturedProxySecrets } from "../config.js";
import { initAuthAdmin } from "./auth-routes.js";
import { createApp } from "./index.js";

afterEach(() => {
	resetCapturedProxySecrets();
	delete process.env.API_KEYS;
	delete process.env.AUTH_ADMIN_KEYS;
	initAuthAdmin();
});

async function withApp<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
	const server = createApp().listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const port = (server.address() as AddressInfo).port;
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("auth UI stays hidden when provisioning is disabled", async () => {
	await withApp(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/auth`);
		assert.equal(response.status, 404);
		assert.equal((await response.json() as { error: { code: string } }).error.code, "not_found");
	});
});

test("auth UI bypasses the completion key and sends hardened single-page headers", async () => {
	process.env.API_KEYS = "completion-key";
	process.env.AUTH_ADMIN_KEYS = "admin-key";

	await withApp(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/auth?engine=%3Cscript%3E`);
		const html = await response.text();

		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		const csp = response.headers.get("content-security-policy") ?? "";
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		assert.ok(nonce);
		assert.match(csp, /connect-src 'self'/);
		assert.match(csp, /frame-ancestors 'none'/);
		assert.ok(html.includes(`<script nonce="${nonce}">`));
		assert.ok(html.includes(`<style nonce="${nonce}">`));
		assert.doesNotMatch(html, /<script>/);
	});
});
