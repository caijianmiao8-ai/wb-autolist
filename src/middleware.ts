import { NextRequest, NextResponse } from "next/server";

/**
 * Access gate. When APP_PASSWORD is set, the entire app (pages + /api) requires
 * HTTP Basic Auth — protecting the seller's WB token and AI budget from anyone
 * who can reach the URL. When unset, the app runs open (intended ONLY for
 * local-localhost development); deployment docs require setting APP_PASSWORD.
 *
 * Runs in the Edge runtime, so we use a hand-rolled constant-time compare
 * (Node's crypto.timingSafeEqual isn't available here).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next(); // local/dev: no gate

  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6)); // "user:pass"
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (constantTimeEqual(pass, password)) return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="WB AutoList", charset="UTF-8"',
    },
  });
}

export const config = {
  // protect everything except Next internals/static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
