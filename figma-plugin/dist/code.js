"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // src/plugin/fonts.ts
  var WEIGHT_NAMES = [
    { weight: 100, names: ["Thin", "Hairline"] },
    { weight: 200, names: ["ExtraLight", "Extra Light", "UltraLight"] },
    { weight: 300, names: ["Light"] },
    { weight: 400, names: ["Regular", "Normal", "Book"] },
    { weight: 500, names: ["Medium"] },
    { weight: 600, names: ["SemiBold", "Semi Bold", "DemiBold"] },
    { weight: 700, names: ["Bold"] },
    { weight: 800, names: ["ExtraBold", "Extra Bold", "UltraBold"] },
    { weight: 900, names: ["Black", "Heavy"] }
  ];
  var SANS = ["Inter", "Roboto"];
  var SERIF = ["Georgia", "Times New Roman", "Inter"];
  var MONO = ["Roboto Mono", "Source Code Pro", "Inter"];
  var FAMILY_FALLBACKS = {
    "dm sans": ["DM Sans", "Inter", "Roboto"],
    "red hat display": ["Red Hat Display", "Inter", "Roboto"],
    "geist mono": ["Geist Mono", "Roboto Mono", "JetBrains Mono", "Source Code Pro"],
    inter: ["Inter", "Roboto"],
    "system-ui": SANS,
    "-apple-system": SANS,
    "ui-sans-serif": SANS,
    "ui-serif": SERIF,
    "ui-monospace": MONO,
    // Rounded is a shape, not a family: nothing in Figma answers for it, and the
    // platform's rounded UI face is a sans. Falling back to the sans keeps the
    // text proportional, which is the property that matters.
    "ui-rounded": SANS,
    ui: ["Inter"],
    sans: SANS,
    "sans-serif": SANS,
    serif: SERIF,
    monospace: MONO,
    cursive: ["Inter"]
  };
  var LAST_RESORT = ["Inter", "Roboto", "Arial", "Helvetica"];
  var FONT_LOAD_TIMEOUT_MS = 2e4;
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("font load timed out")), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
  async function createFontResolver(requests) {
    var _a;
    let available;
    try {
      available = await figma.listAvailableFontsAsync();
    } catch (e) {
      available = await figma.listAvailableFontsAsync();
    }
    const families = /* @__PURE__ */ new Map();
    for (const font of available) {
      const key = font.fontName.family.toLowerCase();
      const styles = (_a = families.get(key)) != null ? _a : /* @__PURE__ */ new Set();
      styles.add(font.fontName.style);
      families.set(key, styles);
    }
    const cache = /* @__PURE__ */ new Map();
    const substitutions = /* @__PURE__ */ new Set();
    const resolve = (family, weight, italic) => {
      var _a2;
      const key = `${family}|${weight}|${italic}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const candidates = [
        family,
        ...(_a2 = FAMILY_FALLBACKS[family.toLowerCase()]) != null ? _a2 : [],
        ...LAST_RESORT
      ];
      for (const candidate of candidates) {
        const styles = families.get(candidate.toLowerCase());
        if (!styles) continue;
        const style = pickStyle(styles, weight, italic);
        if (!style) continue;
        const resolved = {
          family: matchCase(available, candidate),
          style
        };
        if (resolved.family.toLowerCase() !== family.toLowerCase()) {
          substitutions.add(`${family} \u2192 ${resolved.family}`);
        }
        cache.set(key, resolved);
        return resolved;
      }
      const fallback = { family: "Inter", style: "Regular" };
      substitutions.add(`${family} \u2192 Inter (not available)`);
      cache.set(key, fallback);
      return fallback;
    };
    const resolveStack = (family, weight, italic) => {
      var _a2;
      if (!family.includes(",")) return resolve(family, weight, italic);
      const parts = family.split(",").map((part) => part.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (families.has(lower) || FAMILY_FALLBACKS[lower]) {
          const font = resolve(part, weight, italic);
          if (part !== parts[0]) substitutions.add(`${parts[0]} \u2192 ${font.family}`);
          return font;
        }
      }
      return resolve((_a2 = parts[0]) != null ? _a2 : "Inter", weight, italic);
    };
    const needed = /* @__PURE__ */ new Map();
    for (const request of requests) {
      const font = resolveStack(request.family, request.weight, request.italic);
      needed.set(`${font.family}|${font.style}`, font);
    }
    const failed = /* @__PURE__ */ new Set();
    await Promise.all(
      Array.from(needed.values()).map(async (font) => {
        try {
          await withTimeout(figma.loadFontAsync(font), FONT_LOAD_TIMEOUT_MS);
        } catch (e) {
          failed.add(`${font.family}|${font.style}`);
          substitutions.add(`${font.family} ${font.style} \u2192 Inter (could not load)`);
        }
      })
    );
    try {
      await withTimeout(figma.loadFontAsync({ family: "Inter", style: "Regular" }), FONT_LOAD_TIMEOUT_MS);
    } catch (e) {
    }
    const safeResolve = (family, weight, italic) => {
      const font = resolveStack(family, weight, italic);
      return failed.has(`${font.family}|${font.style}`) ? { family: "Inter", style: "Regular" } : font;
    };
    return { resolve: safeResolve, substitutions: Array.from(substitutions) };
  }
  function pickStyle(styles, weight, italic) {
    var _a;
    const order = [...WEIGHT_NAMES].sort(
      (a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight)
    );
    for (const entry of order) {
      for (const name of entry.names) {
        const candidate = italic ? `${name} Italic` : name;
        const found = findStyle(styles, candidate);
        if (found) return found;
        if (italic && entry.weight === 400) {
          const plainItalic = findStyle(styles, "Italic");
          if (plainItalic) return plainItalic;
        }
      }
    }
    if (italic) return pickStyle(styles, weight, false);
    return (_a = styles.values().next().value) != null ? _a : null;
  }
  function findStyle(styles, target) {
    const lower = target.toLowerCase();
    for (const style of styles) {
      if (style.toLowerCase() === lower) return style;
    }
    return null;
  }
  function matchCase(available, family) {
    const lower = family.toLowerCase();
    for (const font of available) {
      if (font.fontName.family.toLowerCase() === lower) return font.fontName.family;
    }
    return family;
  }

  // src/errors.ts
  function describeError(error) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const detail = raw.replace(/\s+/g, " ").trim().slice(0, 160);
    const suffix = detail ? ` (${detail})` : "";
    if (/establish connection|internet connection|network|timed out/i.test(detail)) {
      return "Figma could not reach its servers in time (it loads fonts from them). Check your connection and import again.";
    }
    if (/font/i.test(detail)) {
      return `A font this document uses could not be loaded in Figma${suffix}.`;
    }
    return `Something in this document stopped the import${suffix}. Try re-exporting it from Claude Design.`;
  }

  // src/plugin/mapping.ts
  var EMPTY_REPORT = {
    boundByName: 0,
    boundByValue: 0,
    created: 0,
    unmatched: 0,
    samples: []
  };
  function emptyRegistry() {
    return { byPath: /* @__PURE__ */ new Map(), report: __spreadProps(__spreadValues({}, EMPTY_REPORT), { samples: [] }) };
  }
  async function scanTargets() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const local = collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      variableCount: collection.variableIds.length
    }));
    let libraries = [];
    let libraryError;
    try {
      const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      libraries = available.map((collection) => ({
        key: collection.key,
        name: collection.name,
        libraryName: collection.libraryName
      }));
    } catch (error) {
      libraryError = error instanceof Error ? error.message : "Team libraries unavailable";
    }
    return { local, libraries, libraryError };
  }
  async function resolveVariables(system, target, notes = []) {
    const registry = await resolveSystem(system, target);
    if (notes.length > 0 && target.kind !== "none") {
      registry.report.samples = [...notes, ...registry.report.samples].slice(0, SAMPLE_LIMIT);
    }
    return registry;
  }
  async function resolveSystem(system, target) {
    var _a;
    if (!system || system.tokens.length === 0 || target.kind === "none") {
      return emptyRegistry();
    }
    if (target.kind === "build") return buildDesignSystem(system, target);
    const axis = axisThemeSurfaces(system);
    const canHoldModes = axis.length > 0 && wantsOverflow(target);
    const axisSelectors = new Set((_a = system.axis) != null ? _a : []);
    const bindable = system.tokens.filter(
      (token) => token.kind !== "STRING" && (isBaseLayer(token) || canHoldModes && isAxisDeclared(token, axisSelectors))
    );
    const registry = emptyRegistry();
    const picked = target.kind === "local" || target.kind === "library";
    if (picked && !wantsOverflow(target) && axis.length > 0) {
      pushSample(registry.report, noOverflowNote(system, axis));
    }
    if (bindable.length === 0) return registry;
    const candidates = await buildCandidateIndex(target);
    const creation = await prepareCreation(system, target);
    const themeModes = creation && canHoldModes ? installThemeModes(
      creation.collection,
      system,
      creation.created,
      registry,
      // Every surface of the axis, not only the re-themed ones. Light and
      // Dark are one axis and a collection holding Dark but not Light reads
      // as half a job, and it is also the shape a later Build import of the
      // same export would find and reconcile against.
      axisSurfaces(system)
    ) : null;
    for (const token of bindable) {
      const themed = !!themeModes && isRethemed(token, themeModes);
      if (!themed && await resolveToken(token, candidates, registry)) continue;
      if (!creation) {
        registry.report.unmatched++;
        continue;
      }
      const variable = createVariable(token, creation, themeModes);
      if (variable) {
        registry.byPath.set(token.path, variable);
        registry.report.created++;
      } else {
        registry.report.unmatched++;
      }
    }
    if (creation) {
      const pathByName = new Map(system.tokens.map((t) => [t.name, t.path]));
      for (const token of bindable) {
        if (!token.aliasOf) continue;
        const source = registry.byPath.get(token.path);
        const targetPath = pathByName.get(token.aliasOf);
        const aliasTarget = targetPath ? registry.byPath.get(targetPath) : void 0;
        if (!source || !aliasTarget) continue;
        if (source.id === aliasTarget.id) continue;
        if (source.resolvedType !== aliasTarget.resolvedType) continue;
        if (!creation.createdIds.has(source.id)) continue;
        try {
          source.setValueForMode(
            creation.modeId,
            figma.variables.createVariableAlias(aliasTarget)
          );
        } catch (e) {
        }
      }
    }
    return registry;
  }
  function wantsOverflow(target) {
    return (target.kind === "local" || target.kind === "library") && target.createMissing;
  }
  function isAxisDeclared(token, axis) {
    const scopes = token.declaredIn;
    if (!scopes || scopes.includes("")) return false;
    return scopes.some((selector) => axis.has(selector));
  }
  function isRethemed(token, modes) {
    var _a;
    for (const mode of modes) {
      if (!mode.selector) continue;
      const value = (_a = token.bySurface) == null ? void 0 : _a[mode.selector];
      if (value && !sameSurfaceValue(value, token)) return true;
    }
    return false;
  }
  function axisThemeSurfaces(system) {
    var _a, _b;
    const axis = new Set((_a = system.axis) != null ? _a : []);
    if (axis.size === 0) return [];
    return ((_b = system.surfaces) != null ? _b : []).filter(
      (surface) => axis.has(surface.selector) && !ridesBaseMode(system, surface.selector)
    );
  }
  function axisSurfaces(system) {
    var _a, _b;
    const axis = new Set((_a = system.axis) != null ? _a : []);
    return ((_b = system.surfaces) != null ? _b : []).filter((surface) => axis.has(surface.selector));
  }
  function noOverflowNote(system, axis) {
    const affected = rethemedTokenCount(system, axis);
    return `${joinLabels(axis)} re-theme${axis.length === 1 ? "s" : ""} ${affected} of this document's tokens, and the collection you picked is only read from, never written to. With "create variables for what it does not cover" off there is nowhere in this file to hold a second value, so layers under ${axis.length === 1 ? "it" : "them"} imported as literals rather than binding to the wrong theme's colours.`;
  }
  function isLibraryRef(value) {
    return value.__libraryKey !== void 0;
  }
  async function buildCandidateIndex(target) {
    var _a;
    const index = {
      byName: /* @__PURE__ */ new Map(),
      byColor: /* @__PURE__ */ new Map(),
      byFloat: /* @__PURE__ */ new Map()
    };
    if (target.kind === "library") {
      try {
        const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
          target.collectionKey
        );
        for (const variable of variables) {
          for (const key of nameKeys(variable.name)) {
            if (!index.byName.has(key)) {
              index.byName.set(key, {
                __libraryKey: variable.key,
                resolvedType: variable.resolvedType
              });
            }
          }
        }
      } catch (e) {
      }
      return index;
    }
    if (target.kind !== "local") return index;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = collections.find((c) => c.id === target.collectionId);
    if (!collection) return index;
    const modeId = collection.defaultModeId;
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      for (const key of nameKeys(variable.name)) {
        if (!index.byName.has(key)) index.byName.set(key, variable);
      }
      const value = variable.valuesByMode[modeId];
      if (value === void 0 || value === null) continue;
      if (typeof value === "object" && "type" in value) continue;
      if (variable.resolvedType === "COLOR" && typeof value === "object") {
        const rgba = value;
        const key = colorKey({
          r: rgba.r,
          g: rgba.g,
          b: rgba.b,
          a: (_a = rgba.a) != null ? _a : 1
        });
        if (!index.byColor.has(key)) index.byColor.set(key, variable);
      } else if (variable.resolvedType === "FLOAT" && typeof value === "number") {
        if (!index.byFloat.has(value)) index.byFloat.set(value, variable);
      }
    }
    return index;
  }
  async function resolveToken(token, candidates, registry) {
    const wanted = token.kind === "COLOR" ? "COLOR" : "FLOAT";
    for (const key of nameKeys(token.path).concat(nameKeys(token.name))) {
      const hit = candidates.byName.get(key);
      if (!hit) continue;
      const variable = isLibraryRef(hit) ? hit.resolvedType === wanted ? await importLibraryVariable(hit.__libraryKey) : null : hit.resolvedType === wanted ? hit : null;
      if (!variable) continue;
      registry.byPath.set(token.path, variable);
      registry.report.boundByName++;
      pushSample(registry.report, `${token.name} \u2192 ${variable.name} (name)`);
      return true;
    }
    if (token.kind === "COLOR" && token.color) {
      const variable = candidates.byColor.get(colorKey(token.color));
      if (variable) {
        registry.byPath.set(token.path, variable);
        registry.report.boundByValue++;
        pushSample(registry.report, `${token.name} \u2192 ${variable.name} (value)`);
        return true;
      }
    }
    if (token.kind === "FLOAT" && token.float !== void 0) {
      const variable = candidates.byFloat.get(token.float);
      if (variable) {
        registry.byPath.set(token.path, variable);
        registry.report.boundByValue++;
        pushSample(registry.report, `${token.name} \u2192 ${variable.name} (value)`);
        return true;
      }
    }
    return false;
  }
  async function importLibraryVariable(key) {
    try {
      return await figma.variables.importVariableByKeyAsync(key);
    } catch (e) {
      return null;
    }
  }
  var SYSTEM_KEY = "ferry.systemKey";
  function stampedCollection(collections, system, excludedId) {
    if (!system.key) return void 0;
    return collections.find(
      (collection) => collection.id !== excludedId && readPluginData(collection, SYSTEM_KEY) === system.key
    );
  }
  function claimableByName(collection, system) {
    if (!system.key) return true;
    const stamp = readPluginData(collection, SYSTEM_KEY);
    return stamp === "" || stamp === system.key;
  }
  function createStampedCollection(name, system) {
    const collection = figma.variables.createVariableCollection(name);
    if (system.key) writePluginData(collection, SYSTEM_KEY, system.key);
    return collection;
  }
  async function prepareCreation(system, target) {
    var _a;
    const wantsCreation = target.kind === "create" || (target.kind === "local" || target.kind === "library") && target.createMissing;
    if (!wantsCreation) return null;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const targetId = sourceCollectionId(target);
    const preferred = target.kind === "create" ? target.name || system.name || "Design tokens" : system.name || "Design tokens";
    const reusable = (_a = stampedCollection(collections, system, targetId)) != null ? _a : collections.find(
      (c) => c.name === preferred && c.id !== targetId && claimableByName(c, system)
    );
    const name = reusable || !collections.some((c) => c.name === preferred) ? preferred : `${preferred} (imported)`;
    const found = reusable != null ? reusable : collections.find(
      (c) => c.name === name && c.id !== targetId && claimableByName(c, system)
    );
    const collection = found != null ? found : createStampedCollection(name, system);
    const existing = /* @__PURE__ */ new Map();
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (variable) existing.set(variable.name, variable);
    }
    return {
      collection,
      modeId: collection.defaultModeId,
      existing,
      createdIds: /* @__PURE__ */ new Set(),
      created: !found
    };
  }
  function createVariable(token, ctx, modes) {
    const type = token.kind === "COLOR" ? "COLOR" : "FLOAT";
    let variable = ctx.existing.get(token.path);
    if (variable && variable.resolvedType !== type) return null;
    if (!variable) {
      try {
        variable = figma.variables.createVariable(token.path, ctx.collection, type);
      } catch (e) {
        return null;
      }
      ctx.existing.set(token.path, variable);
    }
    ctx.createdIds.add(variable.id);
    const cells = modes ? modes.map((mode) => ({ modeId: mode.modeId, selector: mode.selector })) : [{ modeId: ctx.modeId, selector: null }];
    let attempted = false;
    let wrote = false;
    for (const cell of cells) {
      const value = literalFor(token, cell.selector, type);
      if (value === null) continue;
      attempted = true;
      try {
        variable.setValueForMode(cell.modeId, value);
        wrote = true;
      } catch (e) {
      }
    }
    return attempted && !wrote ? null : variable;
  }
  var BASE_MODE_NAME = "Product";
  async function buildDesignSystem(system, target) {
    var _a;
    const registry = emptyRegistry();
    const report = registry.report;
    report.reused = 0;
    report.aliased = 0;
    report.effectStyles = 0;
    const resolved = await resolveSystemCollection(system, target);
    const collection = resolved.collection;
    const modes = installThemeModes(
      collection,
      system,
      resolved.created,
      registry,
      (_a = system.surfaces) != null ? _a : [],
      target.modes
    );
    const existing = /* @__PURE__ */ new Map();
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (variable) existing.set(variable.name, variable);
    }
    const buildable = system.tokens.filter((token) => buildTypeFor(token, target) !== null).sort((a, b) => buildPathOf(a).localeCompare(buildPathOf(b)));
    const byName = /* @__PURE__ */ new Map();
    const ordered = [
      ...buildable.filter((token) => !token.aliasOf),
      ...buildable.filter((token) => !!token.aliasOf)
    ];
    for (const token of ordered) {
      const type = buildTypeFor(token, target);
      const variable = upsertVariable(buildPathOf(token), type, collection, existing, report);
      if (!variable) continue;
      variable.scopes = scopesFor(token, type);
      if (!writeEveryMode(variable, token, type, modes, report)) continue;
      registry.byPath.set(token.path, variable);
      byName.set(token.name, variable);
    }
    aliasEveryMode(ordered, modes, byName, registry);
    await upsertEffectStyles(system, report);
    return registry;
  }
  async function resolveSystemCollection(system, target) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const excludedId = sourceCollectionId(target);
    const usable = collections.filter((collection) => collection.id !== excludedId);
    const name = target.name || system.name || "Design tokens";
    const stamped = stampedCollection(usable, system, void 0);
    if (stamped) return { collection: stamped, created: false };
    const named = usable.find(
      (collection) => collection.name === name && claimableByName(collection, system)
    );
    if (named) return { collection: named, created: false };
    return { collection: createStampedCollection(name, system), created: true };
  }
  function installThemeModes(collection, system, created, registry, surfaces, wantModes = true) {
    const reconciled = reconcileModes(
      collection,
      system,
      surfaces,
      wantModes,
      created,
      registry.report
    );
    registry.report.modes = reconciled.modes.map((mode) => mode.label);
    registry.themeModes = {
      collection,
      bySelector: bindableModes(
        system,
        reconciled.modes,
        reconciled.unbuilt,
        collection.defaultModeId
      )
    };
    return reconciled.modes;
  }
  function reconcileModes(collection, system, surfaces, wantModes, created, report) {
    var _a, _b, _c;
    const baseId = collection.defaultModeId;
    if (created) {
      try {
        collection.renameMode(baseId, (_a = system.baseModeLabel) != null ? _a : BASE_MODE_NAME);
      } catch (e) {
      }
    }
    const baseLabel = (_c = (_b = collection.modes.find((mode) => mode.modeId === baseId)) == null ? void 0 : _b.name) != null ? _c : BASE_MODE_NAME;
    const built = [{ modeId: baseId, selector: null, label: baseLabel }];
    if (!wantModes || !surfaces || surfaces.length === 0) {
      return { modes: built, unbuilt: surfaces != null ? surfaces : [] };
    }
    const capped = [];
    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i];
      const match = collection.modes.find((mode) => mode.name === surface.label);
      if (match && !built.some((mode) => mode.modeId === match.modeId)) {
        built.push({ modeId: match.modeId, selector: surface.selector, label: surface.label });
        continue;
      }
      if (match) continue;
      try {
        built.push({
          modeId: collection.addMode(surface.label),
          selector: surface.selector,
          label: surface.label
        });
      } catch (e) {
        capped.push(...surfaces.slice(i));
        break;
      }
    }
    if (capped.length > 0) {
      pushSample(report, modeCapNote(system, collection, built, capped));
    }
    return { modes: built, unbuilt: capped };
  }
  function modeCapNote(system, collection, built, capped) {
    const limit = collection.modes.length;
    const folded = capped.filter((surface) => ridesBaseMode(system, surface.selector));
    const literal = capped.filter((surface) => !folded.includes(surface));
    const labels = built.map(
      (mode) => mode.selector === null && folded.length > 0 ? `${mode.label} (holding ${joinLabels(folded)}'s values)` : mode.label
    );
    let note = `This file's plan allows only ${limit} variable mode${limit === 1 ? "" : "s"} per collection, so the import built ${labels.join(", ")}.`;
    if (literal.length > 0) {
      const affected = rethemedTokenCount(system, literal);
      note += ` ${joinLabels(literal)} re-theme${literal.length === 1 ? "s" : ""} ${affected} of those tokens, so layers under ${literal.length === 1 ? "it" : "them"} imported as literals rather than binding to the wrong theme's colours.`;
    }
    return note;
  }
  function joinLabels(surfaces) {
    return joinNames(surfaces.map((surface) => surface.label));
  }
  function joinNames(items) {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  function rethemedTokenCount(system, surfaces) {
    let count = 0;
    for (const token of system.tokens) {
      const rethemed = surfaces.some((surface) => {
        var _a;
        const value = (_a = token.bySurface) == null ? void 0 : _a[surface.selector];
        return !!value && !sameSurfaceValue(value, token);
      });
      if (rethemed) count++;
    }
    return count;
  }
  function ridesBaseMode(system, selector) {
    var _a;
    for (const token of system.tokens) {
      const value = (_a = token.bySurface) == null ? void 0 : _a[selector];
      if (!value) continue;
      if (!sameSurfaceValue(value, token)) return false;
    }
    return true;
  }
  function sameSurfaceValue(a, b) {
    if (a.aliasOf !== b.aliasOf) return false;
    if (a.color || b.color) {
      return !!a.color && !!b.color && colorKey(a.color) === colorKey(b.color);
    }
    if (a.float !== void 0 || b.float !== void 0) return a.float === b.float;
    return a.resolved === b.resolved;
  }
  function bindableModes(system, built, unbuilt, defaultModeId) {
    const bySelector = /* @__PURE__ */ new Map();
    for (const mode of built) {
      if (mode.selector) bySelector.set(mode.selector, mode.modeId);
    }
    for (const surface of unbuilt) {
      if (bySelector.has(surface.selector)) continue;
      if (ridesBaseMode(system, surface.selector)) {
        bySelector.set(surface.selector, defaultModeId);
      }
    }
    return bySelector;
  }
  function upsertVariable(buildPath, type, collection, existing, report) {
    var _a;
    const found = existing.get(buildPath);
    if (found) {
      if (found.resolvedType !== type) {
        report.unmatched++;
        pushSample(
          report,
          `${buildPath} is ${found.resolvedType} in this file but ${type} in the export \u2014 left alone`
        );
        return null;
      }
      report.reused = ((_a = report.reused) != null ? _a : 0) + 1;
      return found;
    }
    try {
      const variable = figma.variables.createVariable(buildPath, collection, type);
      existing.set(buildPath, variable);
      report.created++;
      return variable;
    } catch (e) {
      report.unmatched++;
      return null;
    }
  }
  function writeEveryMode(variable, token, type, modes, report) {
    let wrote = false;
    let reported = false;
    for (const mode of modes) {
      const value = literalFor(token, mode.selector, type);
      if (value === null) continue;
      const before = variable.valuesByMode[mode.modeId];
      try {
        variable.setValueForMode(mode.modeId, value);
        wrote = true;
      } catch (e) {
        report.unmatched++;
        continue;
      }
      if (reported || before === void 0 || sameValue(before, value)) continue;
      if (aliasNameFor(token, mode.selector)) continue;
      pushSample(report, `${variable.name} changed in ${mode.label}`);
      reported = true;
    }
    return wrote;
  }
  function aliasEveryMode(tokens, modes, byName, registry) {
    var _a;
    for (const token of tokens) {
      const source = registry.byPath.get(token.path);
      if (!source) continue;
      for (const mode of modes) {
        const aliasName = aliasNameFor(token, mode.selector);
        if (!aliasName) continue;
        const aliasTarget = byName.get(aliasName);
        if (!aliasTarget) continue;
        if (aliasTarget.id === source.id) continue;
        if (aliasTarget.resolvedType !== source.resolvedType) continue;
        if (aliasTarget.variableCollectionId !== source.variableCollectionId) continue;
        try {
          source.setValueForMode(
            mode.modeId,
            figma.variables.createVariableAlias(aliasTarget)
          );
          registry.report.aliased = ((_a = registry.report.aliased) != null ? _a : 0) + 1;
        } catch (e) {
        }
      }
    }
  }
  function aliasNameFor(token, selector) {
    var _a;
    if (selector) {
      const surfaceValue = (_a = token.bySurface) == null ? void 0 : _a[selector];
      if (surfaceValue) return surfaceValue.aliasOf;
    }
    return token.aliasOf;
  }
  function surfaceValueOf(token, selector) {
    var _a, _b;
    return (_b = selector ? (_a = token.bySurface) == null ? void 0 : _a[selector] : void 0) != null ? _b : {
      resolved: token.resolved,
      color: token.color,
      float: token.float,
      aliasOf: token.aliasOf
    };
  }
  function literalFor(token, selector, type) {
    const source = surfaceValueOf(token, selector);
    if (type === "COLOR") {
      if (!source.color) return null;
      return {
        r: source.color.r,
        g: source.color.g,
        b: source.color.b,
        a: source.color.a
      };
    }
    if (type === "FLOAT") {
      if (source.float !== void 0) return source.float;
      return emToPercent(source.resolved);
    }
    return firstFontFamily(source.resolved);
  }
  function buildTypeFor(token, target) {
    if (token.kind === "COLOR") return "COLOR";
    if (token.kind === "FLOAT") return "FLOAT";
    if (token.category === "font" && emToPercent(token.resolved) !== null) return "FLOAT";
    return target.strings ? "STRING" : null;
  }
  function scopesFor(token, type) {
    var _a;
    switch (token.category) {
      case "color":
        return ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"];
      case "radius":
        return ["CORNER_RADIUS"];
      case "spacing":
        return ["GAP", "WIDTH_HEIGHT"];
      case "font": {
        const path = (_a = token.buildPath) != null ? _a : "";
        if (path.includes("/size/")) return ["FONT_SIZE"];
        if (path.includes("/tracking/")) return ["LETTER_SPACING"];
        if (path.includes("/family/")) return ["FONT_FAMILY"];
        if (path.includes("/weight/")) return ["FONT_WEIGHT"];
        if (path.includes("/leading/")) {
          return /^-?\d*\.?\d+(px|rem)$/.test(token.resolved.trim()) ? ["LINE_HEIGHT"] : [];
        }
        return [];
      }
      default:
        return type === "COLOR" ? ["ALL_FILLS"] : [];
    }
  }
  async function upsertEffectStyles(system, report) {
    var _a, _b;
    const shadows = (_a = system.shadows) != null ? _a : [];
    if (shadows.length === 0) return;
    let styles;
    try {
      styles = await figma.getLocalEffectStylesAsync();
    } catch (e) {
      return;
    }
    const byName = new Map(styles.map((style) => [style.name, style]));
    for (const shadow of shadows) {
      try {
        let style = byName.get(shadow.buildPath);
        if (!style) {
          style = figma.createEffectStyle();
          style.name = shadow.buildPath;
          byName.set(shadow.buildPath, style);
        }
        style.effects = shadow.layers.map(toShadowEffect);
        report.effectStyles = ((_b = report.effectStyles) != null ? _b : 0) + 1;
      } catch (e) {
        pushSample(report, `${shadow.buildPath} could not be created as an effect style`);
      }
    }
  }
  function toShadowEffect(shadow) {
    return {
      type: shadow.type,
      color: {
        r: shadow.color.r,
        g: shadow.color.g,
        b: shadow.color.b,
        a: shadow.color.a
      },
      offset: { x: shadow.offsetX, y: shadow.offsetY },
      radius: shadow.blur,
      spread: shadow.spread,
      visible: true,
      blendMode: "NORMAL",
      showShadowBehindNode: false
    };
  }
  function firstFontFamily(value) {
    const first = value.split(",")[0].trim();
    return first.replace(/^["']|["']$/g, "") || value.trim();
  }
  function emToPercent(value) {
    const match = value.trim().match(/^(-?\d*\.?\d+)em$/);
    if (!match) return null;
    const parsed = parseFloat(match[1]);
    return Number.isNaN(parsed) ? null : parsed * 100;
  }
  function buildPathOf(token) {
    var _a;
    return (_a = token.buildPath) != null ? _a : token.path;
  }
  function isBaseLayer(token) {
    return !token.declaredIn || token.declaredIn.includes("");
  }
  function sourceCollectionId(target) {
    return target.kind === "local" ? target.collectionId : void 0;
  }
  function readPluginData(collection, key) {
    try {
      return collection.getPluginData(key);
    } catch (e) {
      return "";
    }
  }
  function writePluginData(collection, key, value) {
    try {
      collection.setPluginData(key, value);
    } catch (e) {
    }
  }
  function sameValue(a, b) {
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      return a === b;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function bindPaint(paint, token, registry) {
    if (!token) return paint;
    const variable = registry.byPath.get(token.path);
    if (!variable || variable.resolvedType !== "COLOR") return paint;
    try {
      return figma.variables.setBoundVariableForPaint(paint, "color", variable);
    } catch (e) {
      return paint;
    }
  }
  function bindField(node, field, token, registry) {
    if (!token) return;
    const variable = registry.byPath.get(token.path);
    if (!variable || variable.resolvedType !== "FLOAT") return;
    try {
      node.setBoundVariable(field, variable);
    } catch (e) {
    }
  }
  function nameKeys(name) {
    var _a;
    const flat = normalize(name);
    const leaf = normalize((_a = name.split("/").pop()) != null ? _a : name);
    if (flat === leaf) return [flat];
    if (/^\d+$/.test(leaf) || leaf.length < 4) return [flat];
    return [flat, leaf];
  }
  function normalize(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function colorKey(c) {
    return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(
      c.b * 255
    )},${c.a.toFixed(3)}`;
  }
  var SAMPLE_LIMIT = 8;
  function pushSample(report, line) {
    if (report.samples.length < SAMPLE_LIMIT) report.samples.push(line);
  }

  // src/plugin/build.ts
  var NO_DIVERGENCE = /* @__PURE__ */ new Map();
  var IMPORT_GAP = 200;
  async function buildDocument(doc, target, onProgress, options = {}) {
    var _a, _b, _c;
    onProgress(0, 1, "Resolving design tokens\u2026");
    const registry = (_a = options.registry) != null ? _a : await resolveVariables(doc.designSystem, target);
    onProgress(0, 1, "Loading fonts\u2026");
    const fonts = await createFontResolver(collectFontRequests(doc.root));
    const ctx = {
      fonts,
      registry,
      divergence: (_b = options.divergence) != null ? _b : NO_DIVERGENCE,
      themeScope: null,
      warnings: [...doc.warnings],
      count: 0,
      total: countNodes(doc.root),
      onProgress,
      lastYield: Date.now(),
      components: /* @__PURE__ */ new Map(),
      instanceCounts: /* @__PURE__ */ new Map(),
      componentsArea: null
    };
    let root = null;
    const pageBefore = new Set(figma.currentPage.children.map((n) => n.id));
    try {
      root = await buildNode(doc.root, ctx);
      root.name = doc.name;
      unmakeLoneComponents(ctx);
      rehomeStrays(pageBefore, root, ctx);
      if (doc.props) root.setPluginData("ferry.props", JSON.stringify(doc.props));
      if (doc.sceneTime !== void 0) root.setPluginData("ferry.sceneTime", String(doc.sceneTime));
      figma.currentPage.appendChild(root);
      if (options.place !== false) placeBesideExistingContent(root);
      if (ctx.componentsArea) {
        ctx.componentsArea.name = `${doc.name} \xB7 components`;
        if (options.place !== false) placeAreas([root], [ctx.componentsArea]);
      }
    } catch (error) {
      if (root && !root.removed) root.remove();
      if (ctx.componentsArea && !ctx.componentsArea.removed) ctx.componentsArea.remove();
      throw error;
    }
    return {
      root,
      componentsArea: (_c = ctx.componentsArea) != null ? _c : void 0,
      nodeCount: ctx.count,
      mapping: registry.report,
      substitutions: fonts.substitutions,
      warnings: ctx.warnings
    };
  }
  var DEFAULT_FLOW_TRIGGER = { type: "ON_CLICK" };
  async function buildDocuments(docs, target, placement, onProgress, options = {}) {
    var _a, _b;
    const merged = mergeDesignSystems(docs);
    const registry = await resolveVariables(merged.system, target, merged.notes);
    const origin = batchOrigin();
    const roots = [];
    const areas = [];
    const rootByDoc = [];
    const perDocument = [];
    const substitutions = [];
    const warnings = [];
    let nodeCount = 0;
    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index];
      try {
        const result = await buildDocument(
          doc,
          target,
          (done, total, label) => onProgress(index, docs.length, done, total, label),
          { registry, place: false, divergence: merged.divergence[index] }
        );
        roots.push(result.root);
        if (result.componentsArea) areas.push(result.componentsArea);
        rootByDoc.push(result.root);
        nodeCount += result.nodeCount;
        perDocument.push({ name: doc.name, ok: true, nodes: result.nodeCount });
        for (const substitution of result.substitutions) {
          if (!substitutions.includes(substitution)) substitutions.push(substitution);
        }
        for (const warning of result.warnings) {
          warnings.push(docs.length > 1 ? `${doc.name}: ${warning}` : warning);
        }
      } catch (error) {
        console.error(`[ferry] building "${doc.name}" failed`, error instanceof Error ? error.stack || error.message : error);
        rootByDoc.push(null);
        perDocument.push({
          name: doc.name,
          ok: false,
          message: describeError(error)
        });
      }
    }
    const section = ((_a = options.flow) == null ? void 0 : _a.section) ? groupIntoSection(roots, options.flow.section, warnings) : null;
    layoutBatch(roots, section ? { x: 0, y: 0 } : origin, placement);
    if (section) fitSection(section, roots, origin, placement);
    placeAreas(section ? [section] : roots, areas);
    const wiring = options.flow ? await wireFlow(rootByDoc, options.flow, (_b = options.trigger) != null ? _b : DEFAULT_FLOW_TRIGGER, warnings) : { reactions: 0, flows: 0 };
    return {
      roots,
      section,
      nodeCount,
      // Read once. A shared registry hands every BuildResult the same report
      // object, so summing the per-document mappings multiplies the batch
      // totals by the number of documents and nothing fails.
      mapping: registry.report,
      substitutions,
      warnings,
      perDocument,
      reactions: wiring.reactions,
      flows: wiring.flows
    };
  }
  function groupIntoSection(frames, name, warnings) {
    if (frames.length === 0) return null;
    let section = null;
    try {
      section = figma.createSection();
      section.name = name;
      figma.currentPage.appendChild(section);
      for (const frame of frames) section.appendChild(frame);
      return section;
    } catch (error) {
      for (const frame of frames) {
        if (!frame.removed && frame.parent !== figma.currentPage) {
          figma.currentPage.appendChild(frame);
        }
      }
      if (section && !section.removed) section.remove();
      warnings.push(
        `Could not group the import into a section: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
  function fitSection(section, frames, origin, placement) {
    var _a;
    const gap = (_a = placement.gap) != null ? _a : IMPORT_GAP;
    let width = 0;
    let height = 0;
    for (const frame of frames) {
      width = Math.max(width, frame.x + frame.width);
      height = Math.max(height, frame.y + frame.height);
    }
    section.resizeWithoutConstraints(
      Math.max(width + gap, 0.01),
      Math.max(height + gap, 0.01)
    );
    section.x = origin.x;
    section.y = origin.y;
  }
  async function wireFlow(rootByDoc, flow, trigger, warnings) {
    var _a;
    const bySource = /* @__PURE__ */ new Map();
    for (const edge of flow.edges) {
      const from = rootByDoc[edge.from];
      const to = rootByDoc[edge.to];
      if (!from || !to || from === to) continue;
      const list = (_a = bySource.get(from)) != null ? _a : [];
      list.push({
        trigger: edge.delay !== void 0 ? { type: "AFTER_TIMEOUT", timeout: Math.max(0.01, edge.delay) } : trigger,
        // `actions` (plural). The singular `action` field is deprecated in
        // @figma/plugin-typings 1.131.0.
        actions: [
          {
            type: "NODE",
            destinationId: to.id,
            navigation: "NAVIGATE",
            transition: edge.smart ? { type: "SMART_ANIMATE", easing: { type: "EASE_IN_AND_OUT" }, duration: 0.4 } : null,
            resetScrollPosition: false
          }
        ]
      });
      bySource.set(from, list);
    }
    let reactions = 0;
    for (const [frame, list] of bySource) {
      try {
        await frame.setReactionsAsync(list);
        reactions += list.length;
      } catch (error) {
        warnings.push(
          `Could not wire the prototype from "${frame.name}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return { reactions, flows: addFlowStartingPoint(rootByDoc[flow.startIndex], flow.name, warnings) };
  }
  function addFlowStartingPoint(start, name, warnings = []) {
    if (!start) return 0;
    try {
      const existing = figma.currentPage.flowStartingPoints;
      if (existing.some((point) => point.nodeId === start.id)) return 1;
      figma.currentPage.flowStartingPoints = [...existing, { nodeId: start.id, name }];
      return 1;
    } catch (error) {
      warnings.push(
        `Could not start a prototype flow at "${start.name}": ${error instanceof Error ? error.message : String(error)}`
      );
      return 0;
    }
  }
  function mergeDesignSystems(docs) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const divergence = docs.map(() => NO_DIVERGENCE);
    const systems = docs.map((doc) => doc.designSystem).filter((system2) => !!system2);
    if (systems.length === 0) return { system: void 0, divergence, notes: [] };
    if (systems.length === 1) return { system: systems[0], divergence, notes: [] };
    const byPath = /* @__PURE__ */ new Map();
    const ownerByPath = /* @__PURE__ */ new Map();
    for (const doc of docs) {
      for (const token of (_b = (_a = doc.designSystem) == null ? void 0 : _a.tokens) != null ? _b : []) {
        if (byPath.has(token.path)) continue;
        byPath.set(token.path, token);
        ownerByPath.set(token.path, doc.name);
      }
    }
    const shadowsByPath = /* @__PURE__ */ new Map();
    for (const system2 of systems) {
      for (const shadow of (_c = system2.shadows) != null ? _c : []) {
        if (!shadowsByPath.has(shadow.buildPath)) shadowsByPath.set(shadow.buildPath, shadow);
      }
    }
    const surfaces = (_d = systems.find((system2) => {
      var _a2;
      return (_a2 = system2.surfaces) == null ? void 0 : _a2.length;
    })) == null ? void 0 : _d.surfaces;
    const declared = /* @__PURE__ */ new Set();
    for (const system2 of systems) {
      for (const selector of (_e = system2.axis) != null ? _e : []) declared.add(selector);
    }
    const axis = (surfaces != null ? surfaces : []).filter((surface) => declared.has(surface.selector)).map((surface) => surface.selector);
    const system = {
      name: (_g = (_f = systems.find((system2) => system2.name)) == null ? void 0 : _f.name) != null ? _g : "",
      tokens: [...byPath.values()],
      surfaces,
      axis: axis.length > 0 ? axis : void 0,
      baseModeLabel: (_h = systems.find((system2) => system2.baseModeLabel)) == null ? void 0 : _h.baseModeLabel,
      key: (_i = systems.find((system2) => system2.key)) == null ? void 0 : _i.key,
      shadows: shadowsByPath.size > 0 ? [...shadowsByPath.values()] : void 0
    };
    const notes = findDivergence(docs, byPath, ownerByPath, surfaces, divergence);
    return { system, divergence, notes };
  }
  function findDivergence(docs, byPath, ownerByPath, surfaces, out) {
    var _a, _b;
    const selectors = [
      null,
      ...(surfaces != null ? surfaces : []).map((surface) => surface.selector)
    ];
    const notes = [];
    for (let index = 0; index < docs.length; index++) {
      const found = /* @__PURE__ */ new Map();
      for (const token of (_b = (_a = docs[index].designSystem) == null ? void 0 : _a.tokens) != null ? _b : []) {
        const bound = byPath.get(token.path);
        if (!bound || bound === token) continue;
        const differs = selectors.some(
          (selector) => !sameSurfaceValue(surfaceValueOf(token, selector), surfaceValueOf(bound, selector))
        );
        if (differs) found.set(token.path, { declared: token, bound });
      }
      if (found.size === 0) continue;
      out[index] = found;
      notes.push(divergenceNote(docs[index].name, found, ownerByPath));
    }
    return notes;
  }
  function divergenceNote(name, divergent, ownerByPath) {
    const tokens = [...divergent.values()].map((entry) => entry.declared.name).sort();
    const shown = tokens.slice(0, 3);
    const rest = tokens.length - shown.length;
    const list = rest > 0 ? `${shown.join(", ")} and ${rest} others` : joinNames(shown);
    const owners = joinNames([
      ...new Set([...divergent.keys()].map((path) => {
        var _a;
        return (_a = ownerByPath.get(path)) != null ? _a : "";
      }))
    ]);
    const one = tokens.length === 1;
    return `${name} declares ${list} at ${one ? "a different value" : "different values"} from ${owners}, which declared ${one ? "it" : "them"} first. One name is one variable, so ${owners}'s value${one ? "" : "s"} ${one ? "is" : "are"} what the file holds and the affected layers in ${name} imported as literals rather than binding to a colour they do not render.`;
  }
  function batchOrigin() {
    let maxX = -Infinity;
    for (const node of figma.currentPage.children) {
      maxX = Math.max(maxX, node.x + node.width);
    }
    return { x: maxX === -Infinity ? 0 : maxX + IMPORT_GAP, y: 0 };
  }
  function layoutBatch(frames, origin, placement = {}) {
    var _a, _b;
    const gap = (_a = placement.gap) != null ? _a : IMPORT_GAP;
    const columns = Math.max(1, (_b = placement.columns) != null ? _b : Math.ceil(Math.sqrt(frames.length)));
    let x = origin.x;
    let y = origin.y;
    let rowHeight = 0;
    frames.forEach((frame, index) => {
      if (index > 0 && index % columns === 0) {
        x = origin.x;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      frame.x = x;
      frame.y = y;
      x += frame.width + gap;
      rowHeight = Math.max(rowHeight, frame.height);
    });
  }
  function countNodes(node) {
    let total = 1;
    for (const child of node.children) total += countNodes(child);
    if (node.hover) total += countNodes(node.hover);
    return total;
  }
  async function maybeYield(ctx, label) {
    const now = Date.now();
    if (now - ctx.lastYield < yieldBudget) return;
    ctx.onProgress(ctx.count, ctx.total, label);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waited = Date.now() - now;
    yieldBudget = waited > 400 ? 2e3 : 120;
    ctx.lastYield = Date.now();
  }
  var yieldBudget = 120;
  function collectFontRequests(node, out = []) {
    var _a;
    if (node.text) {
      for (const run of node.text.runs) {
        out.push({
          family: ((_a = run.fontStack) == null ? void 0 : _a.length) ? run.fontStack.join(",") : run.fontFamily,
          weight: run.fontWeight,
          italic: run.italic
        });
      }
    }
    for (const child of node.children) collectFontRequests(child, out);
    if (node.hover) collectFontRequests(node.hover, out);
    return out;
  }
  function placeBesideExistingContent(root) {
    let maxX = -Infinity;
    for (const node of figma.currentPage.children) {
      if (node === root) continue;
      maxX = Math.max(maxX, node.x + node.width);
    }
    root.x = maxX === -Infinity ? 0 : maxX + IMPORT_GAP;
    root.y = 0;
  }
  async function buildNode(node, ctx) {
    ctx.count++;
    await maybeYield(ctx, `Building ${node.name || node.kind.toLowerCase()}\u2026`);
    const outerScope = ctx.themeScope;
    if (node.themeScope) ctx.themeScope = node.themeScope;
    let built;
    switch (node.kind) {
      case "TEXT":
        built = await buildText(node, ctx);
        break;
      case "IMAGE":
        built = await buildImage(node, ctx);
        break;
      case "VECTOR":
        built = await buildVector(node, ctx);
        break;
      default:
        built = await buildFrame(node, ctx);
    }
    ctx.themeScope = outerScope;
    if (built && node.themeScope) applyThemeMode(built, node.themeScope, ctx);
    return built;
  }
  function applyThemeMode(node, selector, ctx) {
    const modes = ctx.registry.themeModes;
    const modeId = modes == null ? void 0 : modes.bySelector.get(selector);
    if (!modes || !modeId) return;
    try {
      node.setExplicitVariableModeForCollection(modes.collection, modeId);
    } catch (e) {
    }
  }
  function bindableToken(token, ctx) {
    var _a;
    if (!token) return void 0;
    if (token.themeScope && !((_a = ctx.registry.themeModes) == null ? void 0 : _a.bySelector.has(token.themeScope))) {
      return void 0;
    }
    return rendersWhatItWouldBind(token, ctx) ? token : void 0;
  }
  function rendersWhatItWouldBind(token, ctx) {
    const divergent = ctx.divergence.get(token.path);
    if (!divergent) return true;
    return sameSurfaceValue(
      surfaceValueOf(divergent.declared, ctx.themeScope),
      surfaceValueOf(divergent.bound, boundSelector(ctx))
    );
  }
  function boundSelector(ctx) {
    var _a;
    const scope = ctx.themeScope;
    if (!scope) return null;
    return ((_a = ctx.registry.themeModes) == null ? void 0 : _a.bySelector.has(scope)) ? scope : null;
  }
  async function buildFrame(node, ctx) {
    const frame = figma.createFrame();
    frame.name = node.name;
    frame.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
    frame.clipsContent = node.clips;
    frame.opacity = node.opacity;
    applyFills(frame, node, ctx);
    applyStroke(frame, node, ctx);
    applyCorners(frame, node, ctx);
    applyEffects(frame, node);
    const built = [];
    const builtIr = [];
    for (const child of node.children) {
      let childNode = await buildNode(child, ctx);
      if (!childNode) continue;
      if (child.hover && (!child.component || child.component.main)) childNode = await asHoverSet(childNode, child, ctx);
      else if (child.component) childNode = asComponent(childNode, child, ctx);
      frame.appendChild(childNode);
      built.push(childNode);
      builtIr.push(child);
    }
    if (node.layout) {
      const layout = node.layout;
      frame.layoutMode = layout.mode;
      frame.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
      frame.itemSpacing = layout.gap;
      if (layout.wrap) frame.counterAxisSpacing = layout.crossGap;
      frame.paddingTop = layout.padding.top;
      frame.paddingRight = layout.padding.right;
      frame.paddingBottom = layout.padding.bottom;
      frame.paddingLeft = layout.padding.left;
      if (node.border) {
        try {
          frame.strokesIncludedInLayout = true;
        } catch (e) {
        }
      }
      frame.primaryAxisAlignItems = layout.primaryAlign;
      if (layout.crossAlign === "BASELINE" && layout.mode === "HORIZONTAL") {
        try {
          frame.counterAxisAlignItems = "BASELINE";
        } catch (e) {
          frame.counterAxisAlignItems = "CENTER";
        }
      } else {
        frame.counterAxisAlignItems = layout.crossAlign === "BASELINE" ? "CENTER" : layout.crossAlign;
      }
      if (layout.hugContent) {
        frame.primaryAxisSizingMode = "AUTO";
        frame.counterAxisSizingMode = "AUTO";
      } else {
        frame.primaryAxisSizingMode = "FIXED";
        frame.counterAxisSizingMode = "FIXED";
        frame.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
      }
      bindField(frame, "itemSpacing", bindableToken(layout.gapToken, ctx), ctx.registry);
      if (layout.paddingTokens) {
        bindField(frame, "paddingTop", bindableToken(layout.paddingTokens.top, ctx), ctx.registry);
        bindField(frame, "paddingRight", bindableToken(layout.paddingTokens.right, ctx), ctx.registry);
        bindField(frame, "paddingBottom", bindableToken(layout.paddingTokens.bottom, ctx), ctx.registry);
        bindField(frame, "paddingLeft", bindableToken(layout.paddingTokens.left, ctx), ctx.registry);
      }
      applyChildSizing(builtIr, built, ctx);
      pinAbsoluteChildren(builtIr, built, ctx);
    } else {
      for (let i = 0; i < built.length; i++) {
        built[i].x = builtIr[i].x;
        built[i].y = builtIr[i].y;
      }
    }
    for (let i = 0; i < built.length; i++) {
      if (builtIr[i].rotation) rotateInPlace(built[i], builtIr[i], !node.layout || !!builtIr[i].absolute);
    }
    if (node.mask) applyMask(frame, node, ctx);
    return frame;
  }
  function applyMask(frame, node, ctx) {
    try {
      const mask = figma.createRectangle();
      mask.name = "Mask";
      mask.resize(Math.max(frame.width, 0.01), Math.max(frame.height, 0.01));
      mask.fills = [{ type: "IMAGE", imageHash: figma.createImage(figma.base64Decode(node.mask)).hash, scaleMode: "FILL" }];
      const paints = frame.fills;
      const layers = [mask];
      if (Array.isArray(paints) && paints.length > 0) {
        const fill = figma.createRectangle();
        fill.name = "Fill";
        fill.resize(Math.max(frame.width, 0.01), Math.max(frame.height, 0.01));
        fill.fills = paints;
        fill.cornerRadius = frame.cornerRadius === figma.mixed ? 0 : frame.cornerRadius;
        frame.fills = [];
        layers.push(fill);
      }
      layers.forEach((layer, i) => {
        frame.insertChild(i, layer);
        if (frame.layoutMode !== "NONE") layer.layoutPositioning = "ABSOLUTE";
        layer.x = 0;
        layer.y = 0;
      });
      mask.isMask = true;
      try {
        mask.maskType = "ALPHA";
      } catch (e) {
      }
    } catch (error) {
      ctx.warnings.push(`The fade on "${node.name}" was not carried: ${error.message}`);
    }
  }
  function asComponent(built, ir, ctx) {
    var _a;
    const spec = ir.component;
    if (built.type !== "FRAME") return built;
    try {
      if (spec.main) {
        const layerName = built.name;
        const main2 = figma.createComponentFromNode(built);
        main2.setPluginData("ferry.layer", layerName);
        main2.name = spec.name;
        ctx.components.set(spec.key, main2);
        return main2;
      }
      const main = ctx.components.get(spec.key);
      if (!main) return built;
      const instance = main.createInstance();
      instance.name = built.name;
      if (Math.abs(instance.width - built.width) > 0.01 || Math.abs(instance.height - built.height) > 0.01) {
        instance.resize(built.width, built.height);
      }
      carryOverrides(built, instance, ctx);
      const drift = geometryDrift(built, instance);
      if (drift) {
        instance.remove();
        console.log(`[ferry] kept one "${spec.name}" as a plain layer: as an instance, ${drift}`);
        return built;
      }
      built.remove();
      ctx.instanceCounts.set(spec.key, ((_a = ctx.instanceCounts.get(spec.key)) != null ? _a : 0) + 1);
      return instance;
    } catch (error) {
      ctx.warnings.push(`Kept "${ir.name}" as a plain layer: ${error.message}`);
      return built;
    }
  }
  async function asHoverSet(built, ir, ctx) {
    var _a, _b, _c;
    const hoverBuilt = await buildNode(ir.hover, ctx);
    if (!hoverBuilt) return built;
    try {
      const area = componentsArea(ctx);
      const layerName = built.name;
      const standard = asComponentNode(built);
      const hovered = asComponentNode(hoverBuilt);
      area.appendChild(standard);
      area.appendChild(hovered);
      standard.name = "State=Default";
      hovered.name = "State=Hover";
      const set = figma.combineAsVariants([standard, hovered], area);
      set.name = (_b = (_a = ir.component) == null ? void 0 : _a.name) != null ? _b : ir.name || "Hover";
      set.layoutMode = "HORIZONTAL";
      set.primaryAxisSizingMode = "AUTO";
      set.counterAxisSizingMode = "AUTO";
      set.itemSpacing = 24;
      set.paddingTop = set.paddingRight = set.paddingBottom = set.paddingLeft = 24;
      await standard.setReactionsAsync([
        {
          trigger: { type: "ON_HOVER" },
          actions: [
            {
              type: "NODE",
              destinationId: hovered.id,
              navigation: "CHANGE_TO",
              transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.2 }
            }
          ]
        }
      ]);
      const instance = standard.createInstance();
      instance.name = layerName;
      if (ir.component) {
        ctx.components.set(ir.component.key, standard);
        ctx.instanceCounts.set(ir.component.key, ((_c = ctx.instanceCounts.get(ir.component.key)) != null ? _c : 0) + 1);
      }
      return instance;
    } catch (error) {
      ctx.warnings.push(`Imported "${ir.name}" without its hover state: ${error.message}`);
      if (!hoverBuilt.removed) hoverBuilt.remove();
      return built;
    }
  }
  function componentsArea(ctx) {
    if (ctx.componentsArea && !ctx.componentsArea.removed) return ctx.componentsArea;
    const area = figma.createFrame();
    area.name = "Components";
    area.setPluginData("ferry.role", "components");
    area.fills = [];
    area.clipsContent = false;
    area.layoutMode = "VERTICAL";
    area.primaryAxisSizingMode = "AUTO";
    area.counterAxisSizingMode = "AUTO";
    area.itemSpacing = 40;
    area.paddingTop = area.paddingRight = area.paddingBottom = area.paddingLeft = 40;
    figma.currentPage.appendChild(area);
    ctx.componentsArea = area;
    return area;
  }
  function asComponentNode(node) {
    if (node.type === "FRAME") return figma.createComponentFromNode(node);
    const wrap = figma.createFrame();
    wrap.name = node.name;
    wrap.fills = [];
    wrap.clipsContent = false;
    wrap.layoutMode = "HORIZONTAL";
    wrap.primaryAxisSizingMode = "AUTO";
    wrap.counterAxisSizingMode = "AUTO";
    wrap.appendChild(node);
    return figma.createComponentFromNode(wrap);
  }
  function placeAreas(beside, areas) {
    if (areas.length === 0 || beside.length === 0) return;
    let right = -Infinity;
    let top = Infinity;
    for (const node of beside) {
      right = Math.max(right, node.x + node.width);
      top = Math.min(top, node.y);
    }
    let y = top;
    for (const area of areas) {
      area.x = right + 200;
      area.y = y;
      y += area.height + 120;
    }
  }
  function rehomeStrays(before, root, ctx) {
    for (const node of [...figma.currentPage.children]) {
      if (before.has(node.id) || node === root || node === ctx.componentsArea) continue;
      try {
        componentsArea(ctx).appendChild(node);
      } catch (e) {
      }
    }
  }
  function unmakeLoneComponents(ctx) {
    const depth = (node) => {
      let d = 0;
      for (let p = node.parent; p; p = p.parent) d++;
      return d;
    };
    const lone = Array.from(ctx.components).filter(([key, main]) => {
      var _a;
      return ((_a = ctx.instanceCounts.get(key)) != null ? _a : 0) === 0 && !main.removed;
    }).sort((a, b) => depth(b[1]) - depth(a[1]));
    for (const [key, main] of lone) {
      if (main.findOne((n) => n.type === "COMPONENT")) continue;
      const parent = main.parent;
      if (!parent || !("insertChild" in parent)) continue;
      try {
        const stand = main.createInstance();
        parent.insertChild(parent.children.indexOf(main), stand);
        const m = main;
        const s = stand;
        if (m.layoutPositioning === "ABSOLUTE") s.layoutPositioning = "ABSOLUTE";
        s.x = main.x;
        s.y = main.y;
        if ("layoutSizingHorizontal" in m && m.layoutSizingHorizontal) s.layoutSizingHorizontal = m.layoutSizingHorizontal;
        if ("layoutSizingVertical" in m && m.layoutSizingVertical) s.layoutSizingVertical = m.layoutSizingVertical;
        s.layoutGrow = m.layoutGrow;
        s.rotation = main.rotation;
        const frame = stand.detachInstance();
        frame.name = main.getPluginData("ferry.layer") || main.name;
        main.remove();
        ctx.components.delete(key);
      } catch (e) {
      }
    }
  }
  function geometryDrift(from, to) {
    const off = (a, b) => Math.abs(a - b) > 0.5;
    if (off(from.width, to.width) || off(from.height, to.height)) {
      return `"${from.name}" came out ${Math.round(to.width)}x${Math.round(to.height)}, not ${Math.round(from.width)}x${Math.round(from.height)}`;
    }
    if ("children" in from && "children" in to) {
      const a = from.children;
      const b = to.children;
      if (a.length !== b.length) return "its layers did not match";
      for (let i = 0; i < a.length; i++) {
        if (off(a[i].x, b[i].x) || off(a[i].y, b[i].y)) return `"${a[i].name}" moved`;
        const inner = geometryDrift(a[i], b[i]);
        if (inner) return inner;
      }
    }
    return null;
  }
  function carryOverrides(from, to, ctx) {
    if (from.type === "TEXT" && to.type === "TEXT") {
      if (from.characters !== to.characters) {
        try {
          to.characters = from.characters;
          if (to.textAutoResize !== from.textAutoResize) to.textAutoResize = from.textAutoResize;
          if (from.textAutoResize !== "WIDTH_AND_HEIGHT") to.resize(from.width, from.height);
        } catch (error) {
          ctx.warnings.push(`Could not set the text "${from.characters.slice(0, 30)}" on an instance: ${error.message}`);
        }
      }
      return;
    }
    if (from.type === "RECTANGLE" && to.type === "RECTANGLE") {
      const paints = from.fills;
      if (Array.isArray(paints) && paints.some((p) => p.type === "IMAGE")) to.fills = paints;
    }
    if ("children" in from && "children" in to) {
      const kids = to.children;
      from.children.forEach((child, i) => {
        if (kids[i]) carryOverrides(child, kids[i], ctx);
      });
    }
  }
  function rotateInPlace(node, ir, positioned) {
    const turnable = node;
    try {
      turnable.rotation = -ir.rotation;
      if (!positioned) return;
      const a = ir.rotation * Math.PI / 180;
      const cx = ir.x + ir.width / 2;
      const cy = ir.y + ir.height / 2;
      node.x = cx - ir.width / 2 * Math.cos(a) + ir.height / 2 * Math.sin(a);
      node.y = cy - ir.width / 2 * Math.sin(a) - ir.height / 2 * Math.cos(a);
    } catch (e) {
    }
  }
  function pinAbsoluteChildren(irChildren, built, ctx) {
    var _a;
    for (let i = 0; i < built.length; i++) {
      if (!((_a = irChildren[i]) == null ? void 0 : _a.absolute)) continue;
      const child = built[i];
      try {
        child.layoutPositioning = "ABSOLUTE";
        child.x = irChildren[i].x;
        child.y = irChildren[i].y;
      } catch (e) {
        ctx.warnings.push(`Could not pin "${child.name}" absolutely`);
      }
    }
  }
  function applyChildSizing(irChildren, built, ctx) {
    var _a;
    for (let i = 0; i < built.length; i++) {
      const spec = (_a = irChildren[i]) == null ? void 0 : _a.sizing;
      if (!spec) continue;
      const child = built[i];
      const canHug = child.type === "TEXT" || (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "INSTANCE") && child.layoutMode !== "NONE";
      try {
        child.layoutSizingHorizontal = spec.horizontal === "HUG" && !canHug ? "FIXED" : spec.horizontal;
      } catch (e) {
        ctx.warnings.push(`Could not set horizontal sizing on "${child.name}"`);
      }
      try {
        child.layoutSizingVertical = spec.vertical === "HUG" && !canHug ? "FIXED" : spec.vertical;
      } catch (e) {
        ctx.warnings.push(`Could not set vertical sizing on "${child.name}"`);
      }
    }
  }
  async function buildText(node, ctx) {
    var _a;
    const spec = node.text;
    if (!spec) return null;
    const text = figma.createText();
    const first = spec.runs[0];
    const baseFont = first ? ctx.fonts.resolve(((_a = first.fontStack) == null ? void 0 : _a.length) ? first.fontStack.join(",") : first.fontFamily, first.fontWeight, first.italic) : { family: "Inter", style: "Regular" };
    try {
      text.fontName = baseFont;
    } catch (e) {
      try {
        text.fontName = { family: "Inter", style: "Regular" };
      } catch (e2) {
        text.remove();
        ctx.warnings.push(`Skipped the text "${spec.characters.slice(0, 40)}": no font could be loaded for it.`);
        return null;
      }
    }
    text.characters = spec.characters;
    text.name = node.name;
    text.opacity = node.opacity;
    text.textAlignHorizontal = spec.align;
    text.textAlignVertical = spec.verticalAlign;
    for (const run of spec.runs) {
      const start = Math.max(0, Math.min(run.start, spec.characters.length));
      const end = Math.max(start, Math.min(run.end, spec.characters.length));
      if (end <= start) continue;
      applyRun(text, start, end, run, ctx);
    }
    text.resize(Math.max(node.width, 1), Math.max(node.height, 1));
    text.textAutoResize = spec.singleLine && !spec.fixedWidth ? "WIDTH_AND_HEIGHT" : "HEIGHT";
    if (spec.singleLine && !spec.fixedWidth && !spec.maxLines && /\s$/.test(spec.characters)) {
      const natural = text.width;
      text.textAutoResize = "HEIGHT";
      text.resize(Math.max(node.width, natural, 1), Math.max(node.height, 1));
    }
    if (spec.singleLine && spec.fixedWidth && !spec.maxLines) {
      text.textAutoResize = "WIDTH_AND_HEIGHT";
      const natural = text.width;
      text.textAutoResize = "HEIGHT";
      text.resize(Math.max(node.width, natural, 1), Math.max(node.height, 1));
    }
    if (spec.maxLines) {
      try {
        text.textAutoResize = "HEIGHT";
        text.resize(Math.max(node.width, 1), Math.max(node.height, 1));
        text.textTruncation = "ENDING";
        text.maxLines = spec.maxLines;
      } catch (e) {
      }
    }
    if (spec.glyphFill) {
      const glyph = toFigmaPaint(spec.glyphFill, ctx);
      if (glyph) {
        text.textAutoResize = "HEIGHT";
        text.resize(Math.max(node.width, 1), Math.max(node.height, 1));
        text.fills = [glyph];
      }
    }
    applyEffects(text, node);
    applyBlend(text, node);
    return text;
  }
  function applyRun(text, start, end, run, ctx) {
    var _a;
    const font = ctx.fonts.resolve(((_a = run.fontStack) == null ? void 0 : _a.length) ? run.fontStack.join(",") : run.fontFamily, run.fontWeight, run.italic);
    try {
      text.setRangeFontName(start, end, font);
      text.setRangeFontSize(start, end, Math.max(1, run.fontSize));
      text.setRangeFills(start, end, [
        bindPaint(
          { type: "SOLID", color: toRGB(run.fill.color), opacity: run.fill.color.a },
          bindableToken(run.fill.token, ctx),
          ctx.registry
        )
      ]);
      text.setRangeLineHeight(
        start,
        end,
        run.lineHeight === null ? { unit: "AUTO" } : { value: run.lineHeight, unit: "PIXELS" }
      );
      text.setRangeLetterSpacing(start, end, {
        value: run.letterSpacing,
        unit: "PIXELS"
      });
      text.setRangeTextDecoration(start, end, run.decoration);
      if (run.underline) {
        try {
          const paint = bindPaint(
            { type: "SOLID", color: toRGB(run.underline.paint.color), opacity: run.underline.paint.color.a },
            bindableToken(run.underline.paint.token, ctx),
            ctx.registry
          );
          text.setRangeTextDecorationColor(start, end, { value: paint });
          text.setRangeTextDecorationThickness(start, end, { value: run.underline.thickness, unit: "PIXELS" });
        } catch (e) {
        }
      }
      text.setRangeTextCase(start, end, run.textCase);
      if (run.href) {
        text.setRangeHyperlink(start, end, { type: "URL", value: run.href });
      }
    } catch (error) {
      ctx.warnings.push(
        `Text styling failed on "${text.name}": ${error.message}`
      );
    }
  }
  async function buildImage(node, ctx) {
    var _a;
    if (!node.imageBytes) return null;
    try {
      const image = figma.createImage(node.imageBytes);
      const rect = figma.createRectangle();
      rect.name = node.name;
      rect.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
      rect.opacity = node.opacity;
      const scale = (_a = node.imageScale) != null ? _a : "CROP";
      rect.fills = [
        scale === "CROP" ? { type: "IMAGE", imageHash: image.hash, scaleMode: "CROP", imageTransform: [[1, 0, 0], [0, 1, 0]] } : { type: "IMAGE", imageHash: image.hash, scaleMode: scale }
      ];
      applyBlend(rect, node);
      applyCorners(rect, node, ctx);
      applyEffects(rect, node);
      return rect;
    } catch (error) {
      ctx.warnings.push(`Image "${node.name}" failed: ${error.message}`);
      return null;
    }
  }
  async function buildVector(node, ctx) {
    if (!node.svg) return null;
    try {
      const wrapper = figma.createNodeFromSvg(node.svg);
      wrapper.name = node.name;
      wrapper.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
      wrapper.opacity = node.opacity;
      if (wrapper.children.length === 1) {
        const child = wrapper.children[0];
        if (Math.abs(child.width - wrapper.width) < 0.5 && Math.abs(child.height - wrapper.height) < 0.5) {
          figma.currentPage.appendChild(child);
          wrapper.remove();
          child.name = node.name;
          if ("opacity" in child) child.opacity = node.opacity;
          return child;
        }
      }
      return wrapper;
    } catch (error) {
      ctx.warnings.push(`SVG "${node.name}" failed: ${error.message}`);
      return null;
    }
  }
  function applyFills(node, ir, ctx) {
    applyBlend(node, ir);
    if (ir.fills.length === 0) {
      node.fills = [];
      return;
    }
    node.fills = ir.fills.map((paint) => toFigmaPaint(paint, ctx)).filter((p) => p !== null);
  }
  function toFigmaPaint(paint, ctx) {
    if (paint.type === "SOLID") {
      const solid = {
        type: "SOLID",
        color: toRGB(paint.color),
        opacity: paint.color.a
      };
      return bindPaint(solid, bindableToken(paint.token, ctx), ctx.registry);
    }
    if (paint.type === "IMAGE") {
      try {
        const image = figma.createImage(figma.base64Decode(paint.bytesBase64));
        return paint.scaleMode === "TILE" && paint.scalingFactor ? { type: "IMAGE", imageHash: image.hash, scaleMode: "TILE", scalingFactor: paint.scalingFactor } : { type: "IMAGE", imageHash: image.hash, scaleMode: paint.scaleMode };
      } catch (e) {
        return null;
      }
    }
    if (paint.type === "GRADIENT_LINEAR") {
      return {
        type: "GRADIENT_LINEAR",
        gradientTransform: gradientTransform(paint.angle),
        gradientStops: paint.stops.map((stop) => ({
          position: Math.min(1, Math.max(0, stop.position)),
          color: __spreadProps(__spreadValues({}, toRGB(stop.color)), { a: stop.color.a })
        }))
      };
    }
    return null;
  }
  var BLEND_MODES = {
    multiply: "MULTIPLY",
    screen: "SCREEN",
    overlay: "OVERLAY",
    darken: "DARKEN",
    lighten: "LIGHTEN",
    "color-dodge": "COLOR_DODGE",
    "color-burn": "COLOR_BURN",
    "hard-light": "HARD_LIGHT",
    "soft-light": "SOFT_LIGHT",
    difference: "DIFFERENCE",
    exclusion: "EXCLUSION",
    hue: "HUE",
    saturation: "SATURATION",
    color: "COLOR",
    luminosity: "LUMINOSITY",
    "plus-lighter": "LINEAR_DODGE"
  };
  function applyBlend(node, ir) {
    const mode = ir.blendMode ? BLEND_MODES[ir.blendMode] : void 0;
    if (!mode) return;
    try {
      node.blendMode = mode;
    } catch (e) {
    }
  }
  function gradientTransform(angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [
      [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
      [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos]
    ];
  }
  function applyStroke(node, ir, ctx) {
    if (!ir.border) {
      node.strokes = [];
      return;
    }
    const { weights, paint, dashed } = ir.border;
    node.strokes = [
      bindPaint(
        { type: "SOLID", color: toRGB(paint.color), opacity: paint.color.a },
        bindableToken(paint.token, ctx),
        ctx.registry
      )
    ];
    node.strokeAlign = "INSIDE";
    const uniform = weights.top === weights.right && weights.top === weights.bottom && weights.top === weights.left;
    if (uniform) {
      node.strokeWeight = weights.top;
    } else {
      node.strokeTopWeight = weights.top;
      node.strokeRightWeight = weights.right;
      node.strokeBottomWeight = weights.bottom;
      node.strokeLeftWeight = weights.left;
    }
    if (dashed) node.dashPattern = [4, 4];
  }
  function applyCorners(node, ir, ctx) {
    const { tl, tr, br, bl } = ir.cornerRadius;
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = br;
    node.bottomLeftRadius = bl;
    if (tl === tr && tl === br && tl === bl) {
      const corner = bindableToken(ir.cornerToken, ctx);
      bindField(node, "topLeftRadius", corner, ctx.registry);
      bindField(node, "topRightRadius", corner, ctx.registry);
      bindField(node, "bottomRightRadius", corner, ctx.registry);
      bindField(node, "bottomLeftRadius", corner, ctx.registry);
    }
  }
  function applyEffects(node, ir) {
    if (ir.effects.length === 0) return;
    const effects = [];
    for (const effect of ir.effects) {
      effects.push(toFigmaEffect(effect));
    }
    node.effects = effects;
  }
  function toFigmaEffect(effect) {
    switch (effect.type) {
      case "LAYER_BLUR":
      case "BACKGROUND_BLUR":
        return {
          type: effect.type,
          radius: effect.radius,
          visible: true
        };
      default:
        return {
          type: effect.type,
          color: __spreadProps(__spreadValues({}, toRGB(effect.color)), { a: effect.color.a }),
          offset: { x: effect.offsetX, y: effect.offsetY },
          radius: effect.blur,
          spread: effect.spread,
          visible: true,
          blendMode: "NORMAL"
        };
    }
  }
  function toRGB(color) {
    return { r: color.r, g: color.g, b: color.b };
  }

  // src/plugin/main.ts
  figma.showUI(__html__, { width: 400, height: 620, themeColors: true });
  var DESIGN_SYSTEM_STORAGE_KEY = "designSystemCss";
  var MAX_STORED_DESIGN_SYSTEM_BYTES = 5e5;
  loadStoredDesignSystem();
  loadLinkCode();
  async function loadLinkCode() {
    const KEY = "ferry.link.code";
    try {
      let code = await figma.clientStorage.getAsync(KEY);
      if (typeof code !== "string" || !/^\d{4}-\d{4}$/.test(code)) {
        const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join("");
        code = `${digits.slice(0, 4)}-${digits.slice(4)}`;
        await figma.clientStorage.setAsync(KEY, code);
      }
      post({ type: "link-code", code });
    } catch (e) {
    }
  }
  async function loadStoredDesignSystem() {
    try {
      const stored = await figma.clientStorage.getAsync(
        DESIGN_SYSTEM_STORAGE_KEY
      );
      if (stored && typeof stored.css === "string" && stored.css.length > 0) {
        post({ type: "design-system-loaded", stored });
      }
    } catch (e) {
    }
  }
  async function saveDesignSystem(css, fileCount) {
    const bytes = new TextEncoder().encode(css).length;
    if (bytes > MAX_STORED_DESIGN_SYSTEM_BYTES) {
      post({ type: "design-system-saved", ok: false, reason: "too-large" });
      return;
    }
    try {
      const stored = { css, fileCount };
      await figma.clientStorage.setAsync(DESIGN_SYSTEM_STORAGE_KEY, stored);
      post({ type: "design-system-saved", ok: true });
    } catch (error) {
      post({
        type: "design-system-saved",
        ok: false,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  figma.ui.onmessage = async (message) => {
    if (false) {
      await selftest(message);
      return;
    }
    switch (message.type) {
      case "cancel":
        figma.closePlugin();
        return;
      case "resize":
        figma.ui.resize(message.width, message.height);
        return;
      case "notify":
        figma.notify(message.message, { error: message.error });
        return;
      case "scan-targets":
        try {
          post({ type: "targets", summary: await scanTargets() });
        } catch (error) {
          post({
            type: "targets",
            summary: { local: [], libraries: [], libraryError: describeError(error) }
          });
        }
        return;
      case "import":
        await runImport(message);
        return;
      case "save-design-system":
        await saveDesignSystem(message.css, message.fileCount);
        return;
      case "clear-design-system":
        await figma.clientStorage.deleteAsync(DESIGN_SYSTEM_STORAGE_KEY).catch(() => {
        });
        return;
    }
  };
  async function runImport(message) {
    var _a;
    try {
      const result = await buildDocuments(
        message.docs,
        message.target,
        (_a = message.placement) != null ? _a : {},
        (docIndex, docCount, done, total, label) => {
          var _a2, _b;
          return post({
            type: "import-progress",
            docIndex,
            docCount,
            docName: (_b = (_a2 = message.docs[docIndex]) == null ? void 0 : _a2.name) != null ? _b : "",
            done,
            total,
            label
          });
        },
        { flow: message.flow }
      );
      if (result.roots.length === 0) {
        const failure = result.perDocument.find((entry) => !entry.ok);
        post({
          type: "import-failed",
          message: failure && !failure.ok ? failure.message : "Nothing was imported."
        });
        figma.notify("Import failed", { error: true });
        return;
      }
      const focus = result.section ? [result.section] : result.roots;
      figma.currentPage.selection = focus;
      figma.viewport.scrollAndZoomIntoView(focus);
      figma.commitUndo();
      post({
        type: "import-complete",
        nodes: result.nodeCount,
        frames: result.roots.length,
        mapping: result.mapping,
        substitutions: result.substitutions,
        warnings: result.warnings,
        reactions: result.reactions,
        flows: result.flows,
        perDocument: result.perDocument
      });
      const bound = result.mapping.boundByName + result.mapping.boundByValue;
      const bits = [`${result.nodeCount} layers`];
      if (result.roots.length > 1) bits.unshift(`${result.roots.length} frames`);
      if (bound > 0) bits.push(`${bound} tokens mapped`);
      if (result.mapping.created > 0) bits.push(`${result.mapping.created} created`);
      const failed = result.perDocument.filter((entry) => !entry.ok).length;
      if (failed > 0) bits.push(`${failed} skipped`);
      figma.notify(`Imported ${bits.join(", ")}`);
    } catch (error) {
      console.error("[ferry] import failed", error instanceof Error ? error.stack || error.message : error);
      post({ type: "import-failed", message: describeError(error) });
      figma.notify("Import failed. See the panel for details.", { error: true });
    }
  }
  function post(message) {
    figma.ui.postMessage(message);
  }
})();
