import { describe, expect, it } from "vitest";
import { parseMobileRoute, routeHash } from "../apps/web/src/client/mobile-navigation.js";
import { visibleViewport } from "../apps/web/src/client/mobile-viewport.js";

describe("phone session navigation", () => {
  it("round trips a session link without putting IDs in the request path", () => {
    const route = parseMobileRoute("#/agents/00000000-0000-4000-8000-000000000004");
    expect(route.page).toBe("session");
    expect(routeHash(route)).toBe("#/agents/00000000-0000-4000-8000-000000000004");
    expect(parseMobileRoute("#/settings")).toEqual({ page: "settings" });
  });
  it("rejects malformed, partial and non-session links into the agent list", () => {
    for (const hash of ["", "#/agents", "#/agents/not-a-session", "#/agents/%E0%A4%A", "#/agents/00000000-0000-4000-8000-000000000004/more", "#https://elsewhere.test"]) {
      expect(parseMobileRoute(hash)).toEqual({ page: "agents" });
    }
  });
});
describe("Android visible viewport", () => {
  it("uses the keyboard's visible height and offset without measuring application layout", () => {
    expect(visibleViewport({ height: 419.7, offsetTop: 57.1, offsetLeft: 0, scale: 1 }, 844)).toEqual({ height: 420, offsetTop: 57, offsetLeft: 0 });
  });
  it("leaves browser pinch zoom independent from root sizing and supports browsers without the API", () => {
    expect(visibleViewport({ height: 400, offsetTop: 100, offsetLeft: 50, scale: 2 }, 844)).toEqual({ height: 844, offsetTop: 0, offsetLeft: 0 });
    expect(visibleViewport(null, 768)).toEqual({ height: 768, offsetTop: 0, offsetLeft: 0 });
  });
});
