//#region node_modules/workbox-core/_version.js
try {
	self["workbox:core:7.4.0"] && _();
} catch {}
var e = (e, ...t) => {
	let n = e;
	return t.length > 0 && (n += ` :: ${JSON.stringify(t)}`), n;
}, t = class extends Error {
	constructor(t, n) {
		let r = e(t, n);
		super(r), this.name = t, this.details = n;
	}
}, n = {
	googleAnalytics: "googleAnalytics",
	precache: "precache-v2",
	prefix: "workbox",
	runtime: "runtime",
	suffix: typeof registration < "u" ? registration.scope : ""
}, r = (e) => [
	n.prefix,
	e,
	n.suffix
].filter((e) => e && e.length > 0).join("-"), i = (e) => {
	for (let t of Object.keys(n)) e(t);
}, a = {
	updateDetails: (e) => {
		i((t) => {
			typeof e[t] == "string" && (n[t] = e[t]);
		});
	},
	getGoogleAnalyticsName: (e) => e || r(n.googleAnalytics),
	getPrecacheName: (e) => e || r(n.precache),
	getPrefix: () => n.prefix,
	getRuntimeName: (e) => e || r(n.runtime),
	getSuffix: () => n.suffix
};
//#endregion
//#region node_modules/workbox-core/_private/waitUntil.js
function o(e, t) {
	let n = t();
	return e.waitUntil(n), n;
}
//#endregion
//#region node_modules/workbox-precaching/_version.js
try {
	self["workbox:precaching:7.4.0"] && _();
} catch {}
//#endregion
//#region node_modules/workbox-precaching/utils/createCacheKey.js
var s = "__WB_REVISION__";
function c(e) {
	if (!e) throw new t("add-to-cache-list-unexpected-type", { entry: e });
	if (typeof e == "string") {
		let t = new URL(e, location.href);
		return {
			cacheKey: t.href,
			url: t.href
		};
	}
	let { revision: n, url: r } = e;
	if (!r) throw new t("add-to-cache-list-unexpected-type", { entry: e });
	if (!n) {
		let e = new URL(r, location.href);
		return {
			cacheKey: e.href,
			url: e.href
		};
	}
	let i = new URL(r, location.href), a = new URL(r, location.href);
	return i.searchParams.set(s, n), {
		cacheKey: i.href,
		url: a.href
	};
}
//#endregion
//#region node_modules/workbox-precaching/utils/PrecacheInstallReportPlugin.js
var l = class {
	constructor() {
		this.updatedURLs = [], this.notUpdatedURLs = [], this.handlerWillStart = async ({ request: e, state: t }) => {
			t && (t.originalRequest = e);
		}, this.cachedResponseWillBeUsed = async ({ event: e, state: t, cachedResponse: n }) => {
			if (e.type === "install" && t && t.originalRequest && t.originalRequest instanceof Request) {
				let e = t.originalRequest.url;
				n ? this.notUpdatedURLs.push(e) : this.updatedURLs.push(e);
			}
			return n;
		};
	}
}, u = class {
	constructor({ precacheController: e }) {
		this.cacheKeyWillBeUsed = async ({ request: e, params: t }) => {
			let n = t?.cacheKey || this._precacheController.getCacheKeyForURL(e.url);
			return n ? new Request(n, { headers: e.headers }) : e;
		}, this._precacheController = e;
	}
}, d;
function f() {
	if (d === void 0) {
		let e = new Response("");
		if ("body" in e) try {
			new Response(e.body), d = !0;
		} catch {
			d = !1;
		}
		d = !1;
	}
	return d;
}
//#endregion
//#region node_modules/workbox-core/copyResponse.js
async function ee(e, n) {
	let r = null;
	if (e.url && (r = new URL(e.url).origin), r !== self.location.origin) throw new t("cross-origin-copy-response", { origin: r });
	let i = e.clone(), a = {
		headers: new Headers(i.headers),
		status: i.status,
		statusText: i.statusText
	}, o = n ? n(a) : a, s = f() ? i.body : await i.blob();
	return new Response(s, o);
}
//#endregion
//#region node_modules/workbox-core/_private/getFriendlyURL.js
var te = (e) => new URL(String(e), location.href).href.replace(RegExp(`^${location.origin}`), "");
//#endregion
//#region node_modules/workbox-core/_private/cacheMatchIgnoreParams.js
function p(e, t) {
	let n = new URL(e);
	for (let e of t) n.searchParams.delete(e);
	return n.href;
}
async function m(e, t, n, r) {
	let i = p(t.url, n);
	if (t.url === i) return e.match(t, r);
	let a = Object.assign(Object.assign({}, r), { ignoreSearch: !0 }), o = await e.keys(t, a);
	for (let t of o) if (i === p(t.url, n)) return e.match(t, r);
}
//#endregion
//#region node_modules/workbox-core/_private/Deferred.js
var ne = class {
	constructor() {
		this.promise = new Promise((e, t) => {
			this.resolve = e, this.reject = t;
		});
	}
}, h = /* @__PURE__ */ new Set();
//#endregion
//#region node_modules/workbox-core/_private/executeQuotaErrorCallbacks.js
async function re() {
	for (let e of h) await e();
}
//#endregion
//#region node_modules/workbox-core/_private/timeout.js
function ie(e) {
	return new Promise((t) => setTimeout(t, e));
}
//#endregion
//#region node_modules/workbox-strategies/_version.js
try {
	self["workbox:strategies:7.4.0"] && _();
} catch {}
//#endregion
//#region node_modules/workbox-strategies/StrategyHandler.js
function g(e) {
	return typeof e == "string" ? new Request(e) : e;
}
var ae = class {
	constructor(e, t) {
		this._cacheKeys = {}, Object.assign(this, t), this.event = t.event, this._strategy = e, this._handlerDeferred = new ne(), this._extendLifetimePromises = [], this._plugins = [...e.plugins], this._pluginStateMap = /* @__PURE__ */ new Map();
		for (let e of this._plugins) this._pluginStateMap.set(e, {});
		this.event.waitUntil(this._handlerDeferred.promise);
	}
	async fetch(e) {
		let { event: n } = this, r = g(e);
		if (r.mode === "navigate" && n instanceof FetchEvent && n.preloadResponse) {
			let e = await n.preloadResponse;
			if (e) return e;
		}
		let i = this.hasCallback("fetchDidFail") ? r.clone() : null;
		try {
			for (let e of this.iterateCallbacks("requestWillFetch")) r = await e({
				request: r.clone(),
				event: n
			});
		} catch (e) {
			if (e instanceof Error) throw new t("plugin-error-request-will-fetch", { thrownErrorMessage: e.message });
		}
		let a = r.clone();
		try {
			let e;
			e = await fetch(r, r.mode === "navigate" ? void 0 : this._strategy.fetchOptions);
			for (let t of this.iterateCallbacks("fetchDidSucceed")) e = await t({
				event: n,
				request: a,
				response: e
			});
			return e;
		} catch (e) {
			throw i && await this.runCallbacks("fetchDidFail", {
				error: e,
				event: n,
				originalRequest: i.clone(),
				request: a.clone()
			}), e;
		}
	}
	async fetchAndCachePut(e) {
		let t = await this.fetch(e), n = t.clone();
		return this.waitUntil(this.cachePut(e, n)), t;
	}
	async cacheMatch(e) {
		let t = g(e), n, { cacheName: r, matchOptions: i } = this._strategy, a = await this.getCacheKey(t, "read"), o = Object.assign(Object.assign({}, i), { cacheName: r });
		n = await caches.match(a, o);
		for (let e of this.iterateCallbacks("cachedResponseWillBeUsed")) n = await e({
			cacheName: r,
			matchOptions: i,
			cachedResponse: n,
			request: a,
			event: this.event
		}) || void 0;
		return n;
	}
	async cachePut(e, n) {
		let r = g(e);
		await ie(0);
		let i = await this.getCacheKey(r, "write");
		if (!n) throw new t("cache-put-with-no-response", { url: te(i.url) });
		let a = await this._ensureResponseSafeToCache(n);
		if (!a) return !1;
		let { cacheName: o, matchOptions: s } = this._strategy, c = await self.caches.open(o), l = this.hasCallback("cacheDidUpdate"), u = l ? await m(c, i.clone(), ["__WB_REVISION__"], s) : null;
		try {
			await c.put(i, l ? a.clone() : a);
		} catch (e) {
			if (e instanceof Error) throw e.name === "QuotaExceededError" && await re(), e;
		}
		for (let e of this.iterateCallbacks("cacheDidUpdate")) await e({
			cacheName: o,
			oldResponse: u,
			newResponse: a.clone(),
			request: i,
			event: this.event
		});
		return !0;
	}
	async getCacheKey(e, t) {
		let n = `${e.url} | ${t}`;
		if (!this._cacheKeys[n]) {
			let r = e;
			for (let e of this.iterateCallbacks("cacheKeyWillBeUsed")) r = g(await e({
				mode: t,
				request: r,
				event: this.event,
				params: this.params
			}));
			this._cacheKeys[n] = r;
		}
		return this._cacheKeys[n];
	}
	hasCallback(e) {
		for (let t of this._strategy.plugins) if (e in t) return !0;
		return !1;
	}
	async runCallbacks(e, t) {
		for (let n of this.iterateCallbacks(e)) await n(t);
	}
	*iterateCallbacks(e) {
		for (let t of this._strategy.plugins) if (typeof t[e] == "function") {
			let n = this._pluginStateMap.get(t);
			yield (r) => {
				let i = Object.assign(Object.assign({}, r), { state: n });
				return t[e](i);
			};
		}
	}
	waitUntil(e) {
		return this._extendLifetimePromises.push(e), e;
	}
	async doneWaiting() {
		for (; this._extendLifetimePromises.length;) {
			let e = this._extendLifetimePromises.splice(0), t = (await Promise.allSettled(e)).find((e) => e.status === "rejected");
			if (t) throw t.reason;
		}
	}
	destroy() {
		this._handlerDeferred.resolve(null);
	}
	async _ensureResponseSafeToCache(e) {
		let t = e, n = !1;
		for (let e of this.iterateCallbacks("cacheWillUpdate")) if (t = await e({
			request: this.request,
			response: t,
			event: this.event
		}) || void 0, n = !0, !t) break;
		return n || t && t.status !== 200 && (t = void 0), t;
	}
}, v = class {
	constructor(e = {}) {
		this.cacheName = a.getRuntimeName(e.cacheName), this.plugins = e.plugins || [], this.fetchOptions = e.fetchOptions, this.matchOptions = e.matchOptions;
	}
	handle(e) {
		let [t] = this.handleAll(e);
		return t;
	}
	handleAll(e) {
		e instanceof FetchEvent && (e = {
			event: e,
			request: e.request
		});
		let t = e.event, n = typeof e.request == "string" ? new Request(e.request) : e.request, r = "params" in e ? e.params : void 0, i = new ae(this, {
			event: t,
			request: n,
			params: r
		}), a = this._getResponse(i, n, t);
		return [a, this._awaitComplete(a, i, n, t)];
	}
	async _getResponse(e, n, r) {
		await e.runCallbacks("handlerWillStart", {
			event: r,
			request: n
		});
		let i;
		try {
			if (i = await this._handle(n, e), !i || i.type === "error") throw new t("no-response", { url: n.url });
		} catch (t) {
			if (t instanceof Error) {
				for (let a of e.iterateCallbacks("handlerDidError")) if (i = await a({
					error: t,
					event: r,
					request: n
				}), i) break;
			}
			if (!i) throw t;
		}
		for (let t of e.iterateCallbacks("handlerWillRespond")) i = await t({
			event: r,
			request: n,
			response: i
		});
		return i;
	}
	async _awaitComplete(e, t, n, r) {
		let i, a;
		try {
			i = await e;
		} catch {}
		try {
			await t.runCallbacks("handlerDidRespond", {
				event: r,
				request: n,
				response: i
			}), await t.doneWaiting();
		} catch (e) {
			e instanceof Error && (a = e);
		}
		if (await t.runCallbacks("handlerDidComplete", {
			event: r,
			request: n,
			response: i,
			error: a
		}), t.destroy(), a) throw a;
	}
}, y = class e extends v {
	constructor(t = {}) {
		t.cacheName = a.getPrecacheName(t.cacheName), super(t), this._fallbackToNetwork = t.fallbackToNetwork !== !1, this.plugins.push(e.copyRedirectedCacheableResponsesPlugin);
	}
	async _handle(e, t) {
		return await t.cacheMatch(e) || (t.event && t.event.type === "install" ? await this._handleInstall(e, t) : await this._handleFetch(e, t));
	}
	async _handleFetch(e, n) {
		let r, i = n.params || {};
		if (this._fallbackToNetwork) {
			let t = i.integrity, a = e.integrity, o = !a || a === t;
			r = await n.fetch(new Request(e, { integrity: e.mode === "no-cors" ? void 0 : a || t })), t && o && e.mode !== "no-cors" && (this._useDefaultCacheabilityPluginIfNeeded(), await n.cachePut(e, r.clone()));
		} else throw new t("missing-precache-entry", {
			cacheName: this.cacheName,
			url: e.url
		});
		return r;
	}
	async _handleInstall(e, n) {
		this._useDefaultCacheabilityPluginIfNeeded();
		let r = await n.fetch(e);
		if (!await n.cachePut(e, r.clone())) throw new t("bad-precaching-response", {
			url: e.url,
			status: r.status
		});
		return r;
	}
	_useDefaultCacheabilityPluginIfNeeded() {
		let t = null, n = 0;
		for (let [r, i] of this.plugins.entries()) i !== e.copyRedirectedCacheableResponsesPlugin && (i === e.defaultPrecacheCacheabilityPlugin && (t = r), i.cacheWillUpdate && n++);
		n === 0 ? this.plugins.push(e.defaultPrecacheCacheabilityPlugin) : n > 1 && t !== null && this.plugins.splice(t, 1);
	}
};
y.defaultPrecacheCacheabilityPlugin = { async cacheWillUpdate({ response: e }) {
	return !e || e.status >= 400 ? null : e;
} }, y.copyRedirectedCacheableResponsesPlugin = { async cacheWillUpdate({ response: e }) {
	return e.redirected ? await ee(e) : e;
} };
//#endregion
//#region node_modules/workbox-precaching/PrecacheController.js
var b = class {
	constructor({ cacheName: e, plugins: t = [], fallbackToNetwork: n = !0 } = {}) {
		this._urlsToCacheKeys = /* @__PURE__ */ new Map(), this._urlsToCacheModes = /* @__PURE__ */ new Map(), this._cacheKeysToIntegrities = /* @__PURE__ */ new Map(), this._strategy = new y({
			cacheName: a.getPrecacheName(e),
			plugins: [...t, new u({ precacheController: this })],
			fallbackToNetwork: n
		}), this.install = this.install.bind(this), this.activate = this.activate.bind(this);
	}
	get strategy() {
		return this._strategy;
	}
	precache(e) {
		this.addToCacheList(e), this._installAndActiveListenersAdded ||= (self.addEventListener("install", this.install), self.addEventListener("activate", this.activate), !0);
	}
	addToCacheList(e) {
		let n = [];
		for (let r of e) {
			typeof r == "string" ? n.push(r) : r && r.revision === void 0 && n.push(r.url);
			let { cacheKey: e, url: i } = c(r), a = typeof r != "string" && r.revision ? "reload" : "default";
			if (this._urlsToCacheKeys.has(i) && this._urlsToCacheKeys.get(i) !== e) throw new t("add-to-cache-list-conflicting-entries", {
				firstEntry: this._urlsToCacheKeys.get(i),
				secondEntry: e
			});
			if (typeof r != "string" && r.integrity) {
				if (this._cacheKeysToIntegrities.has(e) && this._cacheKeysToIntegrities.get(e) !== r.integrity) throw new t("add-to-cache-list-conflicting-integrities", { url: i });
				this._cacheKeysToIntegrities.set(e, r.integrity);
			}
			if (this._urlsToCacheKeys.set(i, e), this._urlsToCacheModes.set(i, a), n.length > 0) {
				let e = `Workbox is precaching URLs without revision info: ${n.join(", ")}\nThis is generally NOT safe. Learn more at https://bit.ly/wb-precache`;
				console.warn(e);
			}
		}
	}
	install(e) {
		return o(e, async () => {
			let t = new l();
			this.strategy.plugins.push(t);
			for (let [t, n] of this._urlsToCacheKeys) {
				let r = this._cacheKeysToIntegrities.get(n), i = this._urlsToCacheModes.get(t), a = new Request(t, {
					integrity: r,
					cache: i,
					credentials: "same-origin"
				});
				await Promise.all(this.strategy.handleAll({
					params: { cacheKey: n },
					request: a,
					event: e
				}));
			}
			let { updatedURLs: n, notUpdatedURLs: r } = t;
			return {
				updatedURLs: n,
				notUpdatedURLs: r
			};
		});
	}
	activate(e) {
		return o(e, async () => {
			let e = await self.caches.open(this.strategy.cacheName), t = await e.keys(), n = new Set(this._urlsToCacheKeys.values()), r = [];
			for (let i of t) n.has(i.url) || (await e.delete(i), r.push(i.url));
			return { deletedURLs: r };
		});
	}
	getURLsToCacheKeys() {
		return this._urlsToCacheKeys;
	}
	getCachedURLs() {
		return [...this._urlsToCacheKeys.keys()];
	}
	getCacheKeyForURL(e) {
		let t = new URL(e, location.href);
		return this._urlsToCacheKeys.get(t.href);
	}
	getIntegrityForCacheKey(e) {
		return this._cacheKeysToIntegrities.get(e);
	}
	async matchPrecache(e) {
		let t = e instanceof Request ? e.url : e, n = this.getCacheKeyForURL(t);
		if (n) return (await self.caches.open(this.strategy.cacheName)).match(n);
	}
	createHandlerBoundToURL(e) {
		let n = this.getCacheKeyForURL(e);
		if (!n) throw new t("non-precached-url", { url: e });
		return (t) => (t.request = new Request(e), t.params = Object.assign({ cacheKey: n }, t.params), this.strategy.handle(t));
	}
}, x, S = () => (x ||= new b(), x);
//#endregion
//#region node_modules/workbox-routing/_version.js
try {
	self["workbox:routing:7.4.0"] && _();
} catch {}
//#endregion
//#region node_modules/workbox-routing/utils/normalizeHandler.js
var C = (e) => e && typeof e == "object" ? e : { handle: e }, w = class {
	constructor(e, t, n = "GET") {
		this.handler = C(t), this.match = e, this.method = n;
	}
	setCatchHandler(e) {
		this.catchHandler = C(e);
	}
}, oe = class extends w {
	constructor(e, t, n) {
		super(({ url: t }) => {
			let n = e.exec(t.href);
			if (n && (t.origin === location.origin || n.index === 0)) return n.slice(1);
		}, t, n);
	}
}, se = class {
	constructor() {
		this._routes = /* @__PURE__ */ new Map(), this._defaultHandlerMap = /* @__PURE__ */ new Map();
	}
	get routes() {
		return this._routes;
	}
	addFetchListener() {
		self.addEventListener("fetch", ((e) => {
			let { request: t } = e, n = this.handleRequest({
				request: t,
				event: e
			});
			n && e.respondWith(n);
		}));
	}
	addCacheListener() {
		self.addEventListener("message", ((e) => {
			if (e.data && e.data.type === "CACHE_URLS") {
				let { payload: t } = e.data, n = Promise.all(t.urlsToCache.map((t) => {
					typeof t == "string" && (t = [t]);
					let n = new Request(...t);
					return this.handleRequest({
						request: n,
						event: e
					});
				}));
				e.waitUntil(n), e.ports && e.ports[0] && n.then(() => e.ports[0].postMessage(!0));
			}
		}));
	}
	handleRequest({ request: e, event: t }) {
		let n = new URL(e.url, location.href);
		if (!n.protocol.startsWith("http")) return;
		let r = n.origin === location.origin, { params: i, route: a } = this.findMatchingRoute({
			event: t,
			request: e,
			sameOrigin: r,
			url: n
		}), o = a && a.handler, s = e.method;
		if (!o && this._defaultHandlerMap.has(s) && (o = this._defaultHandlerMap.get(s)), !o) return;
		let c;
		try {
			c = o.handle({
				url: n,
				request: e,
				event: t,
				params: i
			});
		} catch (e) {
			c = Promise.reject(e);
		}
		let l = a && a.catchHandler;
		return c instanceof Promise && (this._catchHandler || l) && (c = c.catch(async (r) => {
			if (l) try {
				return await l.handle({
					url: n,
					request: e,
					event: t,
					params: i
				});
			} catch (e) {
				e instanceof Error && (r = e);
			}
			if (this._catchHandler) return this._catchHandler.handle({
				url: n,
				request: e,
				event: t
			});
			throw r;
		})), c;
	}
	findMatchingRoute({ url: e, sameOrigin: t, request: n, event: r }) {
		let i = this._routes.get(n.method) || [];
		for (let a of i) {
			let i, o = a.match({
				url: e,
				sameOrigin: t,
				request: n,
				event: r
			});
			if (o) return i = o, (Array.isArray(i) && i.length === 0 || o.constructor === Object && Object.keys(o).length === 0 || typeof o == "boolean") && (i = void 0), {
				route: a,
				params: i
			};
		}
		return {};
	}
	setDefaultHandler(e, t = "GET") {
		this._defaultHandlerMap.set(t, C(e));
	}
	setCatchHandler(e) {
		this._catchHandler = C(e);
	}
	registerRoute(e) {
		this._routes.has(e.method) || this._routes.set(e.method, []), this._routes.get(e.method).push(e);
	}
	unregisterRoute(e) {
		if (!this._routes.has(e.method)) throw new t("unregister-route-but-not-found-with-method", { method: e.method });
		let n = this._routes.get(e.method).indexOf(e);
		if (n > -1) this._routes.get(e.method).splice(n, 1);
		else throw new t("unregister-route-route-not-registered");
	}
}, T, ce = () => (T || (T = new se(), T.addFetchListener(), T.addCacheListener()), T);
//#endregion
//#region node_modules/workbox-routing/registerRoute.js
function E(e, n, r) {
	let i;
	if (typeof e == "string") {
		let t = new URL(e, location.href);
		i = new w(({ url: e }) => e.href === t.href, n, r);
	} else if (e instanceof RegExp) i = new oe(e, n, r);
	else if (typeof e == "function") i = new w(e, n, r);
	else if (e instanceof w) i = e;
	else throw new t("unsupported-route-type", {
		moduleName: "workbox-routing",
		funcName: "registerRoute",
		paramName: "capture"
	});
	return ce().registerRoute(i), i;
}
//#endregion
//#region node_modules/workbox-precaching/utils/removeIgnoredSearchParams.js
function le(e, t = []) {
	for (let n of [...e.searchParams.keys()]) t.some((e) => e.test(n)) && e.searchParams.delete(n);
	return e;
}
//#endregion
//#region node_modules/workbox-precaching/utils/generateURLVariations.js
function* ue(e, { ignoreURLParametersMatching: t = [/^utm_/, /^fbclid$/], directoryIndex: n = "index.html", cleanURLs: r = !0, urlManipulation: i } = {}) {
	let a = new URL(e, location.href);
	a.hash = "", yield a.href;
	let o = le(a, t);
	if (yield o.href, n && o.pathname.endsWith("/")) {
		let e = new URL(o.href);
		e.pathname += n, yield e.href;
	}
	if (r) {
		let e = new URL(o.href);
		e.pathname += ".html", yield e.href;
	}
	if (i) {
		let e = i({ url: a });
		for (let t of e) yield t.href;
	}
}
//#endregion
//#region node_modules/workbox-precaching/PrecacheRoute.js
var de = class extends w {
	constructor(e, t) {
		super(({ request: n }) => {
			let r = e.getURLsToCacheKeys();
			for (let i of ue(n.url, t)) {
				let t = r.get(i);
				if (t) return {
					cacheKey: t,
					integrity: e.getIntegrityForCacheKey(t)
				};
			}
		}, e.strategy);
	}
};
//#endregion
//#region node_modules/workbox-precaching/addRoute.js
function D(e) {
	E(new de(S(), e));
}
//#endregion
//#region node_modules/workbox-precaching/utils/deleteOutdatedCaches.js
var O = "-precache-", k = async (e, t = O) => {
	let n = (await self.caches.keys()).filter((n) => n.includes(t) && n.includes(self.registration.scope) && n !== e);
	return await Promise.all(n.map((e) => self.caches.delete(e))), n;
};
//#endregion
//#region node_modules/workbox-precaching/cleanupOutdatedCaches.js
function A() {
	self.addEventListener("activate", ((e) => {
		let t = a.getPrecacheName();
		e.waitUntil(k(t).then((e) => {}));
	}));
}
//#endregion
//#region node_modules/workbox-precaching/matchPrecache.js
function j(e) {
	return S().matchPrecache(e);
}
//#endregion
//#region node_modules/workbox-precaching/precache.js
function M(e) {
	S().precache(e);
}
//#endregion
//#region node_modules/workbox-precaching/precacheAndRoute.js
function N(e, t) {
	M(e), D(t);
}
//#endregion
//#region node_modules/workbox-strategies/CacheFirst.js
var P = class extends v {
	async _handle(e, n) {
		let r = await n.cacheMatch(e), i;
		if (!r) try {
			r = await n.fetchAndCachePut(e);
		} catch (e) {
			e instanceof Error && (i = e);
		}
		if (!r) throw new t("no-response", {
			url: e.url,
			error: i
		});
		return r;
	}
};
//#endregion
//#region node_modules/workbox-core/_private/dontWaitFor.js
function F(e) {
	e.then(() => {});
}
//#endregion
//#region node_modules/idb/build/wrap-idb-value.js
var I = (e, t) => t.some((t) => e instanceof t), L, R;
function z() {
	return L ||= [
		IDBDatabase,
		IDBObjectStore,
		IDBIndex,
		IDBCursor,
		IDBTransaction
	];
}
function B() {
	return R ||= [
		IDBCursor.prototype.advance,
		IDBCursor.prototype.continue,
		IDBCursor.prototype.continuePrimaryKey
	];
}
var V = /* @__PURE__ */ new WeakMap(), H = /* @__PURE__ */ new WeakMap(), U = /* @__PURE__ */ new WeakMap(), W = /* @__PURE__ */ new WeakMap(), G = /* @__PURE__ */ new WeakMap();
function fe(e) {
	let t = new Promise((t, n) => {
		let r = () => {
			e.removeEventListener("success", i), e.removeEventListener("error", a);
		}, i = () => {
			t(q(e.result)), r();
		}, a = () => {
			n(e.error), r();
		};
		e.addEventListener("success", i), e.addEventListener("error", a);
	});
	return t.then((t) => {
		t instanceof IDBCursor && V.set(t, e);
	}).catch(() => {}), G.set(t, e), t;
}
function pe(e) {
	if (H.has(e)) return;
	let t = new Promise((t, n) => {
		let r = () => {
			e.removeEventListener("complete", i), e.removeEventListener("error", a), e.removeEventListener("abort", a);
		}, i = () => {
			t(), r();
		}, a = () => {
			n(e.error || new DOMException("AbortError", "AbortError")), r();
		};
		e.addEventListener("complete", i), e.addEventListener("error", a), e.addEventListener("abort", a);
	});
	H.set(e, t);
}
var K = {
	get(e, t, n) {
		if (e instanceof IDBTransaction) {
			if (t === "done") return H.get(e);
			if (t === "objectStoreNames") return e.objectStoreNames || U.get(e);
			if (t === "store") return n.objectStoreNames[1] ? void 0 : n.objectStore(n.objectStoreNames[0]);
		}
		return q(e[t]);
	},
	set(e, t, n) {
		return e[t] = n, !0;
	},
	has(e, t) {
		return e instanceof IDBTransaction && (t === "done" || t === "store") || t in e;
	}
};
function me(e) {
	K = e(K);
}
function he(e) {
	return e === IDBDatabase.prototype.transaction && !("objectStoreNames" in IDBTransaction.prototype) ? function(t, ...n) {
		let r = e.call(J(this), t, ...n);
		return U.set(r, t.sort ? t.sort() : [t]), q(r);
	} : B().includes(e) ? function(...t) {
		return e.apply(J(this), t), q(V.get(this));
	} : function(...t) {
		return q(e.apply(J(this), t));
	};
}
function ge(e) {
	return typeof e == "function" ? he(e) : (e instanceof IDBTransaction && pe(e), I(e, z()) ? new Proxy(e, K) : e);
}
function q(e) {
	if (e instanceof IDBRequest) return fe(e);
	if (W.has(e)) return W.get(e);
	let t = ge(e);
	return t !== e && (W.set(e, t), G.set(t, e)), t;
}
var J = (e) => G.get(e);
//#endregion
//#region node_modules/idb/build/index.js
function _e(e, t, { blocked: n, upgrade: r, blocking: i, terminated: a } = {}) {
	let o = indexedDB.open(e, t), s = q(o);
	return r && o.addEventListener("upgradeneeded", (e) => {
		r(q(o.result), e.oldVersion, e.newVersion, q(o.transaction), e);
	}), n && o.addEventListener("blocked", (e) => n(e.oldVersion, e.newVersion, e)), s.then((e) => {
		a && e.addEventListener("close", () => a()), i && e.addEventListener("versionchange", (e) => i(e.oldVersion, e.newVersion, e));
	}).catch(() => {}), s;
}
function ve(e, { blocked: t } = {}) {
	let n = indexedDB.deleteDatabase(e);
	return t && n.addEventListener("blocked", (e) => t(e.oldVersion, e)), q(n).then(() => void 0);
}
var ye = [
	"get",
	"getKey",
	"getAll",
	"getAllKeys",
	"count"
], be = [
	"put",
	"add",
	"delete",
	"clear"
], Y = /* @__PURE__ */ new Map();
function X(e, t) {
	if (!(e instanceof IDBDatabase && !(t in e) && typeof t == "string")) return;
	if (Y.get(t)) return Y.get(t);
	let n = t.replace(/FromIndex$/, ""), r = t !== n, i = be.includes(n);
	if (!(n in (r ? IDBIndex : IDBObjectStore).prototype) || !(i || ye.includes(n))) return;
	let a = async function(e, ...t) {
		let a = this.transaction(e, i ? "readwrite" : "readonly"), o = a.store;
		return r && (o = o.index(t.shift())), (await Promise.all([o[n](...t), i && a.done]))[0];
	};
	return Y.set(t, a), a;
}
me((e) => ({
	...e,
	get: (t, n, r) => X(t, n) || e.get(t, n, r),
	has: (t, n) => !!X(t, n) || e.has(t, n)
}));
//#endregion
//#region node_modules/workbox-expiration/_version.js
try {
	self["workbox:expiration:7.4.0"] && _();
} catch {}
//#endregion
//#region node_modules/workbox-expiration/models/CacheTimestampsModel.js
var xe = "workbox-expiration", Z = "cache-entries", Q = (e) => {
	let t = new URL(e, location.href);
	return t.hash = "", t.href;
}, Se = class {
	constructor(e) {
		this._db = null, this._cacheName = e;
	}
	_upgradeDb(e) {
		let t = e.createObjectStore(Z, { keyPath: "id" });
		t.createIndex("cacheName", "cacheName", { unique: !1 }), t.createIndex("timestamp", "timestamp", { unique: !1 });
	}
	_upgradeDbAndDeleteOldDbs(e) {
		this._upgradeDb(e), this._cacheName && ve(this._cacheName);
	}
	async setTimestamp(e, t) {
		e = Q(e);
		let n = {
			url: e,
			timestamp: t,
			cacheName: this._cacheName,
			id: this._getId(e)
		}, r = (await this.getDb()).transaction(Z, "readwrite", { durability: "relaxed" });
		await r.store.put(n), await r.done;
	}
	async getTimestamp(e) {
		return (await (await this.getDb()).get(Z, this._getId(e)))?.timestamp;
	}
	async expireEntries(e, t) {
		let n = await this.getDb(), r = await n.transaction(Z).store.index("timestamp").openCursor(null, "prev"), i = [], a = 0;
		for (; r;) {
			let n = r.value;
			n.cacheName === this._cacheName && (e && n.timestamp < e || t && a >= t ? i.push(r.value) : a++), r = await r.continue();
		}
		let o = [];
		for (let e of i) await n.delete(Z, e.id), o.push(e.url);
		return o;
	}
	_getId(e) {
		return this._cacheName + "|" + Q(e);
	}
	async getDb() {
		return this._db ||= await _e(xe, 1, { upgrade: this._upgradeDbAndDeleteOldDbs.bind(this) }), this._db;
	}
}, Ce = class {
	constructor(e, t = {}) {
		this._isRunning = !1, this._rerunRequested = !1, this._maxEntries = t.maxEntries, this._maxAgeSeconds = t.maxAgeSeconds, this._matchOptions = t.matchOptions, this._cacheName = e, this._timestampModel = new Se(e);
	}
	async expireEntries() {
		if (this._isRunning) {
			this._rerunRequested = !0;
			return;
		}
		this._isRunning = !0;
		let e = this._maxAgeSeconds ? Date.now() - this._maxAgeSeconds * 1e3 : 0, t = await this._timestampModel.expireEntries(e, this._maxEntries), n = await self.caches.open(this._cacheName);
		for (let e of t) await n.delete(e, this._matchOptions);
		this._isRunning = !1, this._rerunRequested && (this._rerunRequested = !1, F(this.expireEntries()));
	}
	async updateTimestamp(e) {
		await this._timestampModel.setTimestamp(e, Date.now());
	}
	async isURLExpired(e) {
		if (this._maxAgeSeconds) {
			let t = await this._timestampModel.getTimestamp(e), n = Date.now() - this._maxAgeSeconds * 1e3;
			return t === void 0 || t < n;
		}
		return !1;
	}
	async delete() {
		this._rerunRequested = !1, await this._timestampModel.expireEntries(Infinity);
	}
};
//#endregion
//#region node_modules/workbox-core/registerQuotaErrorCallback.js
function we(e) {
	h.add(e);
}
//#endregion
//#region node_modules/workbox-expiration/ExpirationPlugin.js
var $ = class {
	constructor(e = {}) {
		this.cachedResponseWillBeUsed = async ({ event: e, request: t, cacheName: n, cachedResponse: r }) => {
			if (!r) return null;
			let i = this._isResponseDateFresh(r), a = this._getCacheExpiration(n);
			F(a.expireEntries());
			let o = a.updateTimestamp(t.url);
			if (e) try {
				e.waitUntil(o);
			} catch {}
			return i ? r : null;
		}, this.cacheDidUpdate = async ({ cacheName: e, request: t }) => {
			let n = this._getCacheExpiration(e);
			await n.updateTimestamp(t.url), await n.expireEntries();
		}, this._config = e, this._maxAgeSeconds = e.maxAgeSeconds, this._cacheExpirations = /* @__PURE__ */ new Map(), e.purgeOnQuotaError && we(() => this.deleteCacheAndMetadata());
	}
	_getCacheExpiration(e) {
		if (e === a.getRuntimeName()) throw new t("expire-custom-caches-only");
		let n = this._cacheExpirations.get(e);
		return n || (n = new Ce(e, this._config), this._cacheExpirations.set(e, n)), n;
	}
	_isResponseDateFresh(e) {
		if (!this._maxAgeSeconds) return !0;
		let t = this._getDateHeaderTimestamp(e);
		return t === null || t >= Date.now() - this._maxAgeSeconds * 1e3;
	}
	_getDateHeaderTimestamp(e) {
		if (!e.headers.has("date")) return null;
		let t = e.headers.get("date"), n = new Date(t).getTime();
		return isNaN(n) ? null : n;
	}
	async deleteCacheAndMetadata() {
		for (let [e, t] of this._cacheExpirations) await self.caches.delete(e), await t.delete();
		this._cacheExpirations = /* @__PURE__ */ new Map();
	}
}, Te = "./index.html";
N([{"revision":"9d9532a201bc3abc0fcdeb0391d8b6e6","url":"./assets/_app-exz1ww6a.js"},{"revision":"8c964f7820ea6e2105040c2a5164d634","url":"./assets/endpoints-b5u3b49u.js"},{"revision":"07484c9e5a08e2759aee2dc1f7b2116c","url":"./assets/index-bz7g7rhx.css"},{"revision":"5fc6b99c44c672cba00773da4769dd2b","url":"./assets/index-k3ppw9cq.js"},{"revision":"10c5400068d0398439c967e6bda04b57","url":"./assets/jsx-runtime-eu92a5pu.js"},{"revision":"7879b59aa7b138a53b047ff8051e755c","url":"./assets/lazyRouteComponent-dkszaiup.js"},{"revision":"1c94843db7d592650b0c7d1d26e4b802","url":"./assets/link-ib4prsn5.js"},{"revision":"ee739ef7f8a1e195b3dd980773043c5b","url":"./assets/matchContext-f8oy3lo7.js"},{"revision":"fd7dd0c269d902acb5cb670fe3b478ad","url":"./assets/not-found-ccnnac39.js"},{"revision":"b871f1049739c8ce7944011c59ea6e98","url":"./assets/prepaint-f14kbd49.js"},{"revision":"026deff3b32fe7b54729af120c91375e","url":"./assets/rolldown-runtime-b9miacsj.js"},{"revision":"3e4f1f48a48bd0f5501dcb45ced7358d","url":"./assets/root-mbklpuv4.js"},{"revision":"df989abda5e89c3e65e680690cf7ca05","url":"./assets/useSelector-f2aak1ol.js"},{"revision":"01dd2b088ca2b37da81e13390b2e94b8","url":"./index.html"},{"revision":"dfc02d3012147ec40b9a27d9a06effae","url":"./manifest.webmanifest"}]), A(), E(({ url: e, request: t }) => t.method === "GET" && e.origin === self.location.origin && e.pathname.startsWith(new URL("./assets/", self.registration.scope).pathname), new P({
	cacheName: "hermes-assets-v1",
	plugins: [new $({
		maxEntries: 400,
		maxAgeSeconds: 2592e3,
		purgeOnQuotaError: !0
	})]
})), self.addEventListener("message", (e) => {
	let t = e.data;
	typeof t == "object" && t && t.type === "SKIP_WAITING" && self.skipWaiting();
}), self.addEventListener("activate", (e) => {
	e.waitUntil((async () => {
		let e = (await caches.keys()).filter((e) => e.startsWith("hermes-shell-"));
		await Promise.all(e.map((e) => caches.delete(e))), await self.clients.claim();
	})());
});
function Ee(e, t) {
	let n = e.pathname.startsWith(t.pathname) ? e.pathname.slice(t.pathname.length) : e.pathname;
	return n.startsWith("api/") || n === "health" || n.startsWith("extensions/") || n.startsWith("plugins/") || n.startsWith("dashboard-plugins/") || n === "sw.js" || !n.startsWith("static/") && n.includes("/static/");
}
self.addEventListener("fetch", (e) => {
	let t = e.request;
	if (t.method !== "GET") return;
	let n = new URL(t.url);
	n.origin === self.location.origin && (Ee(n, new URL(self.registration.scope)) || t.mode === "navigate" && e.respondWith((async () => {
		try {
			return await fetch(t);
		} catch {
			return await j(Te) || new Response("Hermes is offline and no cached shell is available.", {
				status: 503,
				headers: { "Content-Type": "text/plain; charset=utf-8" }
			});
		}
	})()));
});
//#endregion
