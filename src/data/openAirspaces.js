import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { ensureGeoidReady, orthometricToEllipsoidal } from './geoid.js';
import {
  clearSelectedEntityContextForLayer,
  getContextStore,
  registerEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * VFR airspace layer — OpenAIP airspace polygons with hybrid-LOD 3D rendering.
 *
 * Data flows through the same-origin /api/openaip proxy (vite.config.js
 * openAipProxy), which owns the OPENAIP_API_KEY and caches per-query.
 * Keyless operation mirrors firmsHeatmap: /api/openaip/status reports
 * {hasKey:false} and the airspaces endpoint answers 503 {error:'no_key'};
 * both land in getStats().error = 'KEY REQUIRED'.
 */

export const AIRSPACES_OVERLAY_SOURCE_ID = 'open-airspaces';
/** Bounded nearest-visible label cohort offered to the shared world overlay. */
export const AIRSPACES_LABEL_COHORT_LIMIT = 160;
/** Shared ambient-label paint budget, matching the infrastructure sources. */
export const AIRSPACES_LABEL_COLLISION_CAPACITY = 96;
const AIRSPACES_LABEL_MAX_DISTANCE_M = 14000000;
const AIRSPACES_LABEL_FADE_START_RATIO = 250000 / 14000000;

const AIRSPACES_API = '/api/openaip/airspaces';
const STATUS_API = '/api/openaip/status';
const REFRESH_INTERVAL_MS = 900_000;
const STATS_REFRESH_INTERVAL_MS = 1000;
/** Viewport query radius cap (the proxy/upstream are per-point queries). */
const MAX_DISTANCE_M = 300000;
/** Camera settle debounce before a viewport-driven refetch. */
const MOVEEND_FETCH_DEBOUNCE_MS = 8000;
const FETCH_LIMIT = 1000;
/** Throttle for the preRender LOD sweep. */
const LOD_CHECK_MS = 650;
/** +/-10% hysteresis on LOD band edges so slow zooms don't thrash rebuilds. */
const LOD_HYSTERESIS = 0.1;
/** Sampleable-surface give-up (mirrors localGeojson's bounded retry budget). */
const MAX_GROUND_RETRIES = 30;
/** Ignore sub-metre camera jitter in the label-refresh motion probe. */
const LABEL_MOTION_EPSILON_M = 0.5;
/** Ignore sub-metre ground-sample noise; reject absurd surface samples. */
const GROUND_SAMPLE_MAX_ABS_HEIGHT_M = 9000;

/** OpenAIP airspace type id per option key (see getParams()). */
export const OPEN_AIRSPACE_TYPE_IDS = Object.freeze({
  gliding: 21,
  aerialSport: 28,
  vfrSector: 32,
  rmz: 6,
  tmz: 5,
  tiz: 23,
  tia: 24,
  danger: 2,
  restricted: 1,
  prohibited: 3,
  ctr: 4,
  atz: 13,
  matz: 14,
  htz: 20,
  other: 0,
});

const OPEN_AIRSPACE_TYPE_KEYS = Object.freeze(Object.keys(OPEN_AIRSPACE_TYPE_IDS));

/** Default type selection: the 7 VFR-friendly classes ON, everything else OFF. */
function defaultTypeOptions() {
  return Object.fromEntries(OPEN_AIRSPACE_TYPE_KEYS.map((key) => [
    key,
    ['gliding', 'aerialSport', 'vfrSector', 'rmz', 'tmz', 'tiz', 'tia'].includes(key),
  ]));
}

/** Type → display name + accent color (task headline mapping). */
const TYPE_STYLE = Object.freeze({
  28: { name: 'Aerial Sporting/Recreational', color: '#ffd166' },
  32: { name: 'VFR Sector', color: '#39d0ff' },
  21: { name: 'Gliding Sector', color: '#5dff9f' },
  6: { name: 'RMZ', color: '#ff9f43' },
  5: { name: 'TMZ', color: '#ff9f43' },
  23: { name: 'TIZ', color: '#4d7cff' },
  24: { name: 'TIA', color: '#4d7cff' },
  13: { name: 'ATZ', color: '#c56bff' },
  20: { name: 'HTZ', color: '#c56bff' },
  14: { name: 'MATZ', color: '#c56bff' },
  1: { name: 'Restricted', color: '#ff6b6b' },
  2: { name: 'Danger', color: '#ff6b6b' },
  3: { name: 'Prohibited', color: '#ff6b6b' },
  0: { name: 'Other', color: '#a0a0a0' },
});

/** Label priority per type so safety-critical classes win the bounded cohort. */
const TYPE_LABEL_PRIORITY = Object.freeze({
  1: 900,
  2: 900,
  3: 900,
  4: 850,
  5: 800,
  6: 800,
  23: 750,
  24: 750,
  13: 700,
  14: 700,
  20: 700,
  32: 650,
  21: 600,
  28: 550,
  0: 400,
});

/** LOD band floors by camera height (index into the ladder below). */
const LOD_CLOSE_MAX = 60000;
const LOD_MID_MAX = 600000;
const LOD_FLOORS = [0, LOD_CLOSE_MAX, LOD_MID_MAX];

const DEFAULT_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

/** Short chip labels for the row-control type toggles (option keys → text). */
export const OPEN_AIRSPACE_CHIP_LABELS = Object.freeze({
  gliding: 'GLIDING',
  aerialSport: 'AERIAL',
  vfrSector: 'VFR SECTOR',
  rmz: 'RMZ',
  tmz: 'TMZ',
  tiz: 'TIZ',
  tia: 'TIA',
  danger: 'DANGER',
  restricted: 'RESTRICTED',
  prohibited: 'PROHIBITED',
  ctr: 'CTR',
  atz: 'ATZ',
  matz: 'MATZ',
  htz: 'HTZ',
  other: 'OTHER',
});

/**
 * Build one shared-host ambient label for an airspace. Non-interactive: the
 * depth-tested native polygon volume remains the click surface. The position
 * is the record's mutable labelPosition Cartesian, so the host re-projects
 * camera-relative placement per frame without a republish.
 * @param {object} record Parsed airspace record.
 * @returns {object}
 */
export function createAirspaceOverlayEntry(record) {
  return {
    id: String(record?.id || ''),
    position: record?.labelPosition,
    variant: 'label',
    title: String(record?.name || ''),
    accent: typeStyle(record?.type).color,
    priority: record?._labelPriority ?? 300,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    minDistance: 0,
    maxDistance: AIRSPACES_LABEL_MAX_DISTANCE_M,
    distanceFadeStartRatio: AIRSPACES_LABEL_FADE_START_RATIO,
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Bind the airspace layer's host visibility and entry lifecycle to the shared
 * world overlay (same contract as the infrastructure/cable publishers).
 * @param {object} [options]
 * @param {string} [options.sourceId]
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void,destroy:function():void}}
 */
export function createAirspaceOverlayPublisher({
  sourceId = AIRSPACES_OVERLAY_SOURCE_ID,
  host = DEFAULT_OVERLAY_HOST,
} = {}) {
  let visible = false;
  let published = false;
  let destroyed = false;
  const sourceOptions = {
    cohortLimit: AIRSPACES_LABEL_COHORT_LIMIT,
    collisionCapacity: AIRSPACES_LABEL_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (destroyed || visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (destroyed || !visible) return;
      host.setEntries(sourceId, entries, sourceOptions);
      published = entries.length > 0;
    },
    hide() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
    },
    destroy() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
      destroyed = true;
    },
  };
}

/**
 * Create the OpenAIP VFR-airspaces data layer.
 * @param {object} [options]
 * @param {object} [options.overlayHost] Test seam for host lifecycle calls.
 * @param {function} [options.screenSpaceEventHandlerFactory] Pick-event handler factory.
 */
export function createOpenAirspacesLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (viewer) => (
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  ),
} = {}) {
  const id = 'open-airspaces';
  const name = 'VFR Airspaces';
  const source = 'OpenAIP';

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _loading = false;
  /** True when the proxy answered 503 {error:'no_key'} / status {hasKey:false}. */
  let _keyRequired = false;
  let _error = null;
  let _count = 0;
  let _lastUpdate = null;
  /** Parsed airspace records currently rendered. */
  let _airspaces = [];
  const _recordById = new Map();
  let _selectedAirspace = null;
  /** Monotonic fetch-ownership token (disable mid-await bail-out). */
  let _fetchGeneration = 0;
  /** Timestamp of the last completed fetch (success or keyless gate). */
  let _lastFetchAt = 0;
  let _preRenderRemover = null;
  let _moveEndRemover = null;
  let _moveEndTimer = null;
  let _clickHandler = null;
  let _lastLodCheck = 0;
  let _lodIndex = -1;
  let _contextIds = new Set();
  const _camPos = new Cesium.Cartesian3();
  const _camDir = new Cesium.Cartesian3();
  let _camSnapValid = false;
  const _options = {
    types: defaultTypeOptions(),
    volumes: true,
  };
  const _overlayPublisher = createAirspaceOverlayPublisher({ host: overlayHost });

  function activeTypeIds() {
    const ids = new Set();
    for (const key of OPEN_AIRSPACE_TYPE_KEYS) {
      if (_options.types[key]) ids.add(OPEN_AIRSPACE_TYPE_IDS[key]);
    }
    return ids;
  }

  function activeTypeCsv() {
    return [...activeTypeIds()].join(',');
  }

  function cameraHeight() {
    return _viewer?.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY;
  }

  function rawLodIndex(height) {
    if (height >= LOD_MID_MAX) return 2;
    if (height >= LOD_CLOSE_MAX) return 1;
    return 0;
  }

  /** LOD index with hysteresis around band edges (0 close, 1 mid, 2 far). */
  function selectLodIndex(height) {
    const raw = rawLodIndex(height);
    if (_lodIndex < 0 || raw === _lodIndex) return raw;
    let index = _lodIndex;
    while (index < raw && height >= LOD_FLOORS[index + 1] * (1 + LOD_HYSTERESIS)) index += 1;
    while (index > raw && height <= LOD_FLOORS[index] * (1 - LOD_HYSTERESIS)) index -= 1;
    return index;
  }

  /** Camera ground point (same lon/lat, height dropped). */
  function cameraSubpoint() {
    const carto = _viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return carto;
  }

  /** Rough ground radius the camera viewport covers, capped at MAX_DISTANCE_M. */
  function viewportRadius(camCarto) {
    const camera = _viewer?.camera;
    if (!camera?.frustum) return MAX_DISTANCE_M;
    const height = Math.max(camCarto?.height || 0, 1000);
    const fovy = camera.frustum.fovy || (Math.PI / 3);
    const halfVertical = height * Math.tan(fovy / 2);
    const canvas = _viewer?.scene?.canvas;
    const aspect = (canvas?.clientWidth && canvas?.clientHeight)
      ? canvas.clientWidth / canvas.clientHeight
      : 1.6;
    const halfHorizontal = halfVertical * aspect;
    // Airspace data is sparse (large polygons), so a view-proportional radius
    // alone starves low-altitude cameras of nearby context. Keep a generous
    // 100 km floor so a street-level view still surfaces the surrounding
    // airspace structure (the proxy caches per-query and limit caps the load).
    const radius = Math.max(halfVertical, halfHorizontal, 100000);
    return Math.min(MAX_DISTANCE_M, radius);
  }

  async function loadFromCamera() {
    if (_destroyed || !_enabled || _loading) return;
    const camCarto = cameraSubpoint();
    if (!camCarto) return;
    const typeCsv = activeTypeCsv();
    if (!typeCsv) {
      // Every type disabled — nothing to ask the feed for.
      _airspaces = [];
      _recordById.clear();
      _count = 0;
      rebuildGeometry();
      return;
    }
    const generation = ++_fetchGeneration;
    _loading = true;
    // positionCartographic returns radians — OpenAIP wants decimal degrees.
    const lat = Cesium.Math.toDegrees(camCarto.latitude);
    const lon = Cesium.Math.toDegrees(camCarto.longitude);
    const dist = Math.round(viewportRadius(camCarto));
    try {
      const url = `${AIRSPACES_API}?pos=${lat.toFixed(5)},${lon.toFixed(5)}&dist=${dist}&type=${typeCsv}&limit=${FETCH_LIMIT}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (generation !== _fetchGeneration || _destroyed || !_enabled) return;
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* non-JSON body */ }
        if (response.status === 503 && payload?.error === 'no_key') {
          _keyRequired = true;
          _error = null;
          _lastFetchAt = Date.now();
          return;
        }
        throw new Error(openAipProxyError(response.status));
      }
      const payload = await response.json();
      if (generation !== _fetchGeneration || _destroyed || !_enabled) return;
      const activeIds = activeTypeIds();
      const parsed = (Array.isArray(payload?.items) ? payload.items : [])
        .map(parseAirspace)
        .filter((record) => record && activeIds.has(record.type));
      // A click-selected airspace survives the swap when the same id returns.
      const previousSelectionId = _selectedAirspace?.id || null;
      _airspaces = parsed;
      _recordById.clear();
      for (const record of _airspaces) _recordById.set(record.id, record);
      _selectedAirspace = previousSelectionId ? _recordById.get(previousSelectionId) || null : null;
      _count = _airspaces.length;
      _lastUpdate = Number.isFinite(payload?.fetchedAt) ? payload.fetchedAt : Date.now();
      _keyRequired = false;
      _error = null;
      _lastFetchAt = Date.now();
      rebuildGeometry();
    } catch (error) {
      if (generation === _fetchGeneration) {
        console.warn(`[Data:${id}] OpenAIP live load failed:`, error);
        _error = String(error?.message || error) || 'live feed unavailable';
      }
    } finally {
      if (generation === _fetchGeneration) _loading = false;
    }
  }

  /** Quick keyless gate so the chip reads KEY REQUIRED without a heavy fetch. */
  async function checkKeyStatus() {
    if (_destroyed) return;
    try {
      const response = await fetch(STATUS_API, { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.hasKey === false) _keyRequired = true;
      }
    } catch { /* non-fatal — the airspaces fetch reports the authoritative truth */ }
  }

  /**
   * Sample the terrain under an airspace centroid once (photoreal mesh or
   * terrain, mirroring localGeojson.sampleLocalGroundHeight) for GND-referenced
   * limits. Bounded give-up so a sampleable-but-failing scene cannot loop.
   * @param {object} record Airspace record.
   * @returns {number} Ground height in meters (0 until sampled).
   */
  function recordGroundHeight(record) {
    if (record.groundSampled) return record.groundHeight;
    if (!record.needsGround || !_viewer?.scene?.sampleHeightSupported) return 0;
    if (record._groundRetries >= MAX_GROUND_RETRIES) return 0;
    record._groundRetries += 1;
    let sampled;
    try {
      const exclude = record.entity ? [record.entity] : [];
      sampled = _viewer.scene.sampleHeight(record.carto, exclude);
    } catch {
      return 0; // tiles not ready; retried on a later rebuild
    }
    if (Number.isFinite(sampled) && Math.abs(sampled) <= GROUND_SAMPLE_MAX_ABS_HEIGHT_M) {
      record.groundSampled = true;
      record.groundHeight = sampled;
      return sampled;
    }
    return 0;
  }

  /** Convert a limit to ellipsoidal meters at a point (GND → terrain-based). */
  function limitToEllipsoidalM(limit, latDeg, lonDeg, groundHeightM) {
    let meters = Number(limit.value) || 0;
    if (limit.unit === 1) meters *= 0.3048; // feet
    else if (limit.unit === 6) meters = meters * 100 * 0.3048; // flight level
    if (limit.referenceDatum === 0) return groundHeightM + meters; // GND
    // MSL and STD are orthometric → add the geoid undulation.
    try {
      return orthometricToEllipsoidal(meters, latDeg, lonDeg);
    } catch {
      return meters; // EGM96 grid not ready — raw MSL is the honest fallback
    }
  }

  function resolveRecordHeights(record) {
    const ground = recordGroundHeight(record);
    const lower = limitToEllipsoidalM(record.lowerLimit, record.lat, record.lon, ground);
    const upper = limitToEllipsoidalM(record.upperLimit, record.lat, record.lon, ground);
    return { lower, upper, ground };
  }

  /** Outer-ring positions at ellipsoid height (perPositionHeight drives height). */
  function ringPositions(record) {
    const flat = [];
    const ring = record.rings[0];
    for (const point of ring) {
      if (Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
        flat.push(point[0], point[1]);
      }
    }
    if (flat.length < 6) return null;
    try {
      return Cesium.Cartesian3.fromDegreesArray(flat);
    } catch {
      return null;
    }
  }

  /**
   * Render one airspace for the current LOD band.
   * close (<60 km camera): extruded volume — height=lower, extrudedHeight=upper,
   *   translucent fill, wireframe outline, classified onto the 3D tiles.
   * mid (60..600 km): flat footprint at the upper limit, translucent.
   * far (>600 km): no polygon (labels only).
   */
  function buildEntityForBand(record, lodIndex) {
    if (lodIndex === 'far') return;
    const positions = ringPositions(record);
    if (!positions) return;
    const { lower, upper } = resolveRecordHeights(record);
    const color = Cesium.Color.fromCssColorString(typeStyle(record.type).color);
    const entity = _dataSource.entities.add({ id: record.id });
    entity.__localLayerId = id;
    const showVolumes = _options.volumes && lodIndex === 0;
    if (showVolumes) {
      const top = Math.max(upper, lower + 1);
      entity.polygon = new Cesium.PolygonGraphics({
        hierarchy: new Cesium.PolygonHierarchy(positions),
        height: lower,
        extrudedHeight: top,
        perPositionHeight: false,
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.12)),
        outline: true,
        outlineColor: color.withAlpha(0.55),
      });
    } else {
      entity.polygon = new Cesium.PolygonGraphics({
        hierarchy: new Cesium.PolygonHierarchy(positions),
        height: upper,
        perPositionHeight: false,
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.10)),
        outline: true,
        outlineColor: color.withAlpha(0.4),
      });
    }
    entity.show = true;
    record.entity = entity;
  }

  function updateRecordLabelPosition(record) {
    const { lower, upper } = resolveRecordHeights(record);
    const mid = Math.max((lower + upper) / 2, 0);
    record.labelPosition = Cesium.Cartesian3.fromRadians(
      record.carto.longitude,
      record.carto.latitude,
      mid,
      Cesium.Ellipsoid.WGS84,
    );
    if (!record._labelEntry) {
      record._labelEntry = createAirspaceOverlayEntry(record);
    }
  }

  /** Rebuild all polygon geometry for the current LOD band (no refetch). */
  function rebuildGeometry() {
    if (!_dataSource || !_viewer) return;
    const lodIndex = selectLodIndex(cameraHeight());
    _lodIndex = lodIndex;
    _dataSource.entities.removeAll();
    for (const record of _airspaces) {
      record.entity = null;
      buildEntityForBand(record, lodIndex);
      updateRecordLabelPosition(record);
    }
    // A selection whose volume is not rendered (far band) has no click surface.
    if (_selectedAirspace && !_selectedAirspace.entity) _selectedAirspace = null;
    refreshContextRegistrations();
    publishLabels();
    governorRequestRender(`airspaces-rebuild:${id}`);
  }

  function registerAirspaceContext(record) {
    if (!record.entity) return record.id;
    registerEntityContext(record.entity, {
      id: record.id,
      layerId: id,
      layerName: name,
      source,
      dataSource: _dataSource,
      label: record.name,
      latitude: record.lat,
      longitude: record.lon,
      properties: {
        typeName: record.typeName,
        icaoClass: record.icaoClass,
        country: record.country,
        upper: formatLimitFeet(record.upperLimit),
        lower: formatLimitFeet(record.lowerLimit),
        frequencies: record.frequencies,
      },
    });
    return record.id;
  }

  function refreshContextRegistrations() {
    let store = null;
    try { store = getContextStore(); } catch { return; }
    const nextIds = new Set();
    for (const record of _airspaces) {
      if (record.entity && record.entity.show) nextIds.add(registerAirspaceContext(record));
    }
    if (_selectedAirspace && _selectedAirspace.entity) {
      nextIds.add(registerAirspaceContext(_selectedAirspace));
    }
    for (const staleId of _contextIds) {
      if (!nextIds.has(staleId)) store.entities.delete(staleId);
    }
    _contextIds = nextIds;
  }

  function clearContextRegistrations() {
    if (!_contextIds.size) return;
    try {
      const store = getContextStore();
      for (const recordId of _contextIds) store.entities.delete(recordId);
    } catch { /* store unavailable */ }
    _contextIds = new Set();
  }

  /** Publish the bounded nearest/highest-priority label cohort to the host. */
  function publishLabels() {
    if (!_viewer || !_enabled || !_airspaces.length) return;
    const cameraPos = _viewer.camera.positionWC;
    if (!cameraPos) return;
    const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPos);
    const candidates = [];
    for (const record of _airspaces) {
      if (!record._labelEntry || !record.labelPosition) continue;
      if (occluder.isPointVisible(record.labelPosition) !== true) continue;
      const distanceM = Cesium.Cartesian3.distance(cameraPos, record.labelPosition);
      if (distanceM > AIRSPACES_LABEL_MAX_DISTANCE_M) continue;
      candidates.push({ record, distanceM });
    }
    candidates.sort((a, b) => (b.record._labelPriority - a.record._labelPriority)
      || (a.distanceM - b.distanceM)
      || String(a.record.id).localeCompare(String(b.record.id)));
    const cohort = [];
    for (let i = 0; i < candidates.length && cohort.length < AIRSPACES_LABEL_COHORT_LIMIT; i += 1) {
      cohort.push(candidates[i].record._labelEntry);
    }
    _overlayPublisher.publish(cohort);
  }

  function cameraMoved() {
    const camera = _viewer?.camera;
    if (!camera?.positionWC) return false;
    if (_camSnapValid
      && Cesium.Cartesian3.equalsEpsilon(camera.positionWC, _camPos, 0, LABEL_MOTION_EPSILON_M)
      && Cesium.Cartesian3.equalsEpsilon(camera.directionWC, _camDir, 0, 1e-7)) {
      return false;
    }
    Cesium.Cartesian3.clone(camera.positionWC, _camPos);
    Cesium.Cartesian3.clone(camera.directionWC, _camDir);
    _camSnapValid = true;
    return true;
  }

  function installLodWatcher() {
    if (_preRenderRemover || !_viewer) return;
    _preRenderRemover = _viewer.scene.preRender.addEventListener(() => {
      if (!_enabled || !_viewer) return;
      const now = performance.now();
      if (now - _lastLodCheck < LOD_CHECK_MS) return;
      _lastLodCheck = now;
      if (!_airspaces.length) return;
      const lodIndex = selectLodIndex(cameraHeight());
      if (lodIndex !== _lodIndex) {
        rebuildGeometry();
        return;
      }
      if (cameraMoved()) publishLabels();
    });
  }

  function removeLodWatcher() {
    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
  }

  function installMoveEndWatcher() {
    if (_moveEndRemover || !_viewer) return;
    _moveEndRemover = _viewer.camera.moveEnd.addEventListener(() => {
      if (!_enabled) return;
      clearTimeout(_moveEndTimer);
      _moveEndTimer = setTimeout(() => {
        _moveEndTimer = null;
        if (!_enabled || _destroyed) return;
        void loadFromCamera();
      }, MOVEEND_FETCH_DEBOUNCE_MS);
    });
  }

  function removeMoveEndWatcher() {
    if (_moveEndTimer) {
      clearTimeout(_moveEndTimer);
      _moveEndTimer = null;
    }
    if (_moveEndRemover) {
      _moveEndRemover();
      _moveEndRemover = null;
    }
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const record = pickedAirspace(picked);
      if (record) {
        _selectedAirspace = record;
        if (_viewer) _viewer.selectedEntity = record.entity;
        try {
          registerAirspaceContext(record);
          selectEntityContext(record.entity);
        } catch { /* context store unavailable */ }
        return;
      }
      clearAirspaceSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  /** Row-control legend: one color swatch per active type with a live count. */
  function activeTypeLegend() {
    const counts = new Map();
    for (const record of _airspaces) {
      counts.set(record.type, (counts.get(record.type) || 0) + 1);
    }
    const legend = [];
    for (const key of OPEN_AIRSPACE_TYPE_KEYS) {
      if (!_options.types[key]) continue;
      const typeId = OPEN_AIRSPACE_TYPE_IDS[key];
      const count = counts.get(typeId) || 0;
      if (!count) continue;
      legend.push({ label: typeStyle(typeId).name, color: typeStyle(typeId).color, count });
    }
    return legend;
  }

  function pickedAirspace(picked) {
    if (!picked) return null;
    const entity = picked?.id || picked?.primitive?.id;
    if (entity && typeof entity === 'object' && entity.__localLayerId === id) {
      return _recordById.get(entity.id) || null;
    }
    return null;
  }

  function clearAirspaceSelection() {
    if (!_selectedAirspace) return;
    _selectedAirspace = null;
    if (_viewer?.selectedEntity?.__localLayerId === id) _viewer.selectedEntity = undefined;
    clearSelectedEntityContextForLayer(id);
  }

  return {
    id,
    name,
    icon: '◈',
    source,
    updateInterval: 0,
    statsRefreshInterval: STATS_REFRESH_INTERVAL_MS,
    refreshInterval: REFRESH_INTERVAL_MS,
    // The type-chip grid + legend render into the right-rail companion panel
    // (index.html #airspace-controls) instead of the data row, keeping the row
    // compact. ui.js owns the panel's source badge / meta line.
    controlsPanelId: 'airspace-controls',

    init(viewer) {
      if (_destroyed) return;
      _viewer = viewer;
      if (!_dataSource) {
        _dataSource = new Cesium.CustomDataSource(id);
        _dataSource.show = false;
        viewer.dataSources.add(_dataSource);
      }
      void ensureGeoidReady().catch(() => {});
    },

    async enable(viewer) {
      if (_destroyed) return;
      _enabled = true;
      _viewer = viewer;
      if (!_dataSource) this.init(viewer);
      if (_dataSource) _dataSource.show = true;
      _overlayPublisher.show();
      installLodWatcher();
      installMoveEndWatcher();
      installClickHandler();
      void checkKeyStatus();
      if (!_airspaces.length && !_loading) await loadFromCamera();
    },

    disable() {
      _enabled = false;
      _fetchGeneration += 1;
      _loading = false;
      clearAirspaceSelection();
      if (_dataSource) _dataSource.show = false;
      _overlayPublisher.hide();
      clearSelectedEntityContextForLayer(id);
      removeClickHandler();
      removeMoveEndWatcher();
      removeLodWatcher();
    },

    async update() {
      if (_destroyed || !_enabled || _loading) return;
      // The manager runs the first update() immediately after enable(); enable()
      // already fetched. Coalesce that redundant request (the 15-minute
      // periodic refresh passes this gate trivially) so a fresh enable never
      // fires two upstream OpenAIP calls back-to-back.
      if (Date.now() - _lastFetchAt < 15000) return;
      await loadFromCamera();
    },

    destroy(viewer) {
      if (_destroyed) return;
      _destroyed = true;
      _enabled = false;
      _fetchGeneration += 1;
      _loading = false;
      clearTimeout(_moveEndTimer);
      _moveEndTimer = null;
      removeLodWatcher();
      removeMoveEndWatcher();
      removeClickHandler();
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _overlayPublisher.destroy();
      clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      _airspaces = [];
      _recordById.clear();
      _count = 0;
      _lastUpdate = null;
      _keyRequired = false;
      _error = null;
      _selectedAirspace = null;
      _lodIndex = -1;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _keyRequired ? 'KEY REQUIRED' : _error,
        loading: _loading,
        source,
      };
    },

    getParams() {
      return {
        types: { ..._options.types },
        volumes: _options.volumes,
      };
    },

    setParams(params = {}) {
      const typesChanged = Boolean(params?.types) || OPEN_AIRSPACE_TYPE_KEYS.some((key) => (
        typeof params?.[key] === 'boolean'
      ));
      if (params?.types && typeof params.types === 'object') {
        for (const key of OPEN_AIRSPACE_TYPE_KEYS) {
          if (typeof params.types[key] === 'boolean') _options.types[key] = params.types[key];
        }
      } else {
        for (const key of OPEN_AIRSPACE_TYPE_KEYS) {
          if (typeof params?.[key] === 'boolean') _options.types[key] = params[key];
        }
      }
      const volumesChanged = typeof params?.volumes === 'boolean'
        && params.volumes !== _options.volumes;
      if (volumesChanged) _options.volumes = params.volumes;
      if (!_enabled || _destroyed) return true;
      if (typesChanged) {
        // A type change alters the query — refetch from the current viewpoint.
        void loadFromCamera();
      } else if (volumesChanged) {
        rebuildGeometry();
      }
      return true;
    },

    /**
     * Snapshot the loaded airspaces as plain JSON-safe analyst records.
     * @param {number} [maxCount=2000] Truncation cap.
     * @returns {Array<{id:string, lat:number, lon:number, name:string, type:number, topFt:number, bottomFt:number}>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_airspaces.length) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const result = [];
      for (const record of _airspaces) {
        result.push({
          id: record.id,
          lat: record.lat,
          lon: record.lon,
          name: record.name,
          type: record.type,
          topFt: record._topFt,
          bottomFt: record._bottomFt,
        });
        if (result.length >= limit) break;
      }
      return result;
    },

    getRowControls() {
      const chips = [];
      for (const key of OPEN_AIRSPACE_TYPE_KEYS) {
        const on = _options.types[key];
        chips.push({
          id: `type-${key}`,
          label: OPEN_AIRSPACE_CHIP_LABELS[key],
          active: on,
          state: on ? 'active' : 'idle',
          title: on
            ? `Hiding ${typeDisplayName(key)} airspaces`
            : `Showing ${typeDisplayName(key)} airspaces`,
          params: { types: { [key]: !on } },
        });
      }
      chips.push({
        id: 'volumes',
        label: _options.volumes ? 'VOLUMES' : 'FOOTPRINTS',
        active: _options.volumes,
        state: _options.volumes ? 'active' : 'idle',
        title: _options.volumes
          ? 'Rendering full 3D airspace volumes — click for flat footprints'
          : 'Rendering flat footprints — click for full 3D volumes',
        params: { volumes: !_options.volumes },
      });
      return {
        chips,
        legend: activeTypeLegend(),
      };
    },
  };
}

/** Type → {name, color}; unknown ids fall back to Other/grey. */
export function typeStyle(type) {
  return TYPE_STYLE[type] || TYPE_STYLE[0];
}

/** Option key → human display name (title/tooltip copy). */
function typeDisplayName(key) {
  return TYPE_STYLE[OPEN_AIRSPACE_TYPE_IDS[key]]?.name || key;
}

/** Type → bounded label priority (higher wins collisions). */
function airspaceTypePriority(type) {
  return TYPE_LABEL_PRIORITY[type] ?? TYPE_LABEL_PRIORITY[0];
}

/**
 * Short, honest stats error for a non-keyless proxy refusal. The proxy never
 * forwards upstream error details (sanitized responses only), so a 502 means
 * "upstream refused and no cache was available" — which is exactly what a
 * keyed-but-rate-limited (429) or down upstream reads as.
 */
function openAipProxyError(status) {
  if (status === 502) return 'OpenAIP upstream unavailable';
  if (status === 500) return 'OpenAIP proxy error';
  return `OpenAIP HTTP ${status}`;
}

function normalizeType(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function parseLimit(raw) {
  if (!raw || typeof raw !== 'object') {
    return { value: 0, unit: 0, referenceDatum: 0 };
  }
  const value = Number(raw.value);
  return {
    value: Number.isFinite(value) ? value : 0,
    unit: normalizeLimitUnit(raw.unit),
    referenceDatum: normalizeLimitDatum(raw.referenceDatum),
  };
}

/** Accept the task's numeric enums and OpenAIP's string spellings defensively. */
function normalizeLimitUnit(value) {
  if (value === 1 || value === '1' || value === 'FT' || value === 'FEET') return 1;
  if (value === 6 || value === '6' || value === 'FL' || value === 'FLIGHT_LEVEL') return 6;
  return 0; // 0 / '0' / 'M' / 'METERS' → meters
}

function normalizeLimitDatum(value) {
  if (value === 0 || value === '0' || value === 'GND' || value === 'SFC') return 0;
  if (value === 2 || value === '2' || value === 'STD' || value === 'UNL') return 2;
  return 1; // 1 / '1' / 'MSL' → mean sea level
}

/** Convert a limit's value to feet (display + analyst seam). */
export function limitToFeet(limit) {
  const value = Number(limit?.value) || 0;
  if (limit?.unit === 1) return value; // already feet
  if (limit?.unit === 6) return value * 100; // flight level → feet
  return value * 3.28084; // meters → feet
}

function formatLimitFeet(limit) {
  return `${Math.round(limitToFeet(limit))} ft`;
}

function extractRings(geometry) {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords)) return [];
  const rings = [];
  const walk = (value) => {
    if (Array.isArray(value) && Array.isArray(value[0]) && typeof value[0][0] === 'number') {
      rings.push(value);
      return;
    }
    for (const child of value) walk(child);
  };
  walk(coords);
  return rings;
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function formatFrequencies(value) {
  if (Array.isArray(value)) {
    const parts = value.map((entry) => String(entry ?? '')).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return cleanText(value);
}

function parseAirspace(raw, index = 0) {
  const type = normalizeType(raw?.type);
  const upperLimit = parseLimit(raw?.upperLimit);
  const lowerLimit = parseLimit(raw?.lowerLimit);
  const rings = extractRings(raw?.geometry);
  if (!rings.length) return null;
  const ring = rings[0];
  let lonSum = 0;
  let latSum = 0;
  let points = 0;
  for (const point of ring) {
    if (Array.isArray(point) && point.length >= 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
      lonSum += point[0];
      latSum += point[1];
      points += 1;
    }
  }
  if (!points) return null;
  const lat = latSum / points;
  const lon = lonSum / points;
  const name = cleanText(raw?.name) || `Airspace ${index + 1}`;
  return {
    id: String(raw?._id || raw?.id || `open-airspace-${index}`),
    name,
    type,
    typeName: typeStyle(type).name,
    icaoClass: cleanText(raw?.icaoClass),
    country: cleanText(raw?.country),
    frequencies: formatFrequencies(raw?.frequencies),
    upperLimit,
    lowerLimit,
    rings,
    lat,
    lon,
    carto: Cesium.Cartographic.fromDegrees(lon, lat),
    needsGround: lowerLimit.referenceDatum === 0 || upperLimit.referenceDatum === 0,
    groundSampled: false,
    groundHeight: 0,
    _groundRetries: 0,
    entity: null,
    labelPosition: null,
    _labelEntry: null,
    _labelPriority: airspaceTypePriority(type),
    _topFt: Math.round(limitToFeet(upperLimit)),
    _bottomFt: Math.round(limitToFeet(lowerLimit)),
  };
}