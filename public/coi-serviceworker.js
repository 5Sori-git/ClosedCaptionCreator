/*! coi-serviceworker v0.1.7 — Guido Zuidhof and contributors, MIT License
 * https://github.com/gzuidhof/coi-serviceworker
 * 정적 호스트(GitHub Pages 등)에서 COOP/COEP 헤더를 주입해
 * cross-origin isolation 을 켜기 위한 서비스워커. 프로젝트에 그대로 포함(vendored).
 */
/* eslint-disable */
let coepCredentialless = false;

if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

    const request =
      coepCredentialless && r.mode === "no-cors"
        ? new Request(r, { credentials: "omit" })
        : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;

          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp",
          );
          if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e)),
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => !(window.chrome || window.netscape),
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };

    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;

    // 이미 등록됐지만 isolation 이 안 잡힌 경우: credentialless -> require-corp 로 강등 후 리로드
    if (controlling && !window.crossOriginIsolated && coi.coepDegrade() && !coepDegrading) {
      window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
      coi.doReload();
    }

    if (controlling) {
      n.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value: coepDegrading ? false : coi.coepCredentialless(),
      });
    }

    if (!window.isSecureContext) {
      !coi.quiet &&
        console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      return;
    }

    if (!n.serviceWorker) {
      !coi.quiet &&
        console.error(
          "COOP/COEP Service Worker not registered, perhaps due to private browsing mode.",
        );
      return;
    }

    if (!window.crossOriginIsolated && coi.shouldRegister()) {
      n.serviceWorker.register(window.document.currentScript.src).then(
        (registration) => {
          !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

          registration.addEventListener("updatefound", () => {
            !coi.quiet &&
              console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
            window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
            coi.doReload();
          });

          if (registration.active && !n.serviceWorker.controller) {
            !coi.quiet &&
              console.log("Reloading page to make use of COOP/COEP Service Worker.");
            window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
            coi.doReload();
          }
        },
        (err) => {
          !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
        },
      );
    }
  })();
}
