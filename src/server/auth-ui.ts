import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { authAdminEnabled } from "./auth-routes.js";

export const AUTH_UI_PATH = "/auth";

const AUTH_UI_HTML = readFileSync(
  new URL("../../tools/auth-test.html", import.meta.url),
  "utf8",
);

/** Serve the single bundled auth client without exposing a static directory. */
export function handleAuthUi(_req: Request, res: Response): void {
  if (!authAdminEnabled()) {
	res.status(404).json({
	  error: {
	    message: "Not found",
	    type: "invalid_request_error",
	    code: "not_found",
	  },
    });
    return;
  }

  const nonce = randomBytes(18).toString("base64");
  const html = AUTH_UI_HTML
    .replace("<style>", `<style nonce="${nonce}">`)
    .replace("<script>", `<script nonce="${nonce}">`);

  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; `
      + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.status(200).type("html").send(html);
}
