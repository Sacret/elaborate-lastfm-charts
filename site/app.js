'use strict';

const API_KEY = '19cf3bc0e703a4376cefa44b9c8d1912';
const API_URL = 'https://ws.audioscrobbler.com/2.0/';

// Last.fm allows about 5 requests per second.
const CONCURRENCY = 5;
const REQUEST_INTERVAL = 220;
const RETRIES = 3;
const TIMEOUT = 10000;
// Last.fm error codes worth retrying: operation failed, service offline,
// temporarily unavailable, rate limit exceeded.
const RETRYABLE_ERRORS = new Set([8, 11, 16, 29]);

const HOUR = 3600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const DEFAULTS = {
  'username': '',
  'chart-type': 'artist',
  'number-of-positions': '20',
  'timeframe': 'last-3-months',
};

const $ = (selector) => document.querySelector(selector);


class LastfmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Cancelled extends Error {}


// Throttling queue: at most CONCURRENCY requests in flight, and no more than
// one new request every REQUEST_INTERVAL milliseconds.
const queue = [];
let active = 0;
let lastStart = 0;
let pumpTimer = null;

function throttled(fn) {
  return new Promise((resolve, reject) => {
    queue.push({fn, resolve, reject});
    pump();
  });
}

function pump() {
  while (queue.length && active < CONCURRENCY) {
    const wait = lastStart + REQUEST_INTERVAL - Date.now();
    if (wait > 0) {
      if (pumpTimer === null) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          pump();
        }, wait);
      }
      return;
    }
    const {fn, resolve, reject} = queue.shift();
    lastStart = Date.now();
    active += 1;
    fn().then(resolve, reject).finally(() => {
      active -= 1;
      pump();
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lastfmOnce(method, params) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({method, api_key: API_KEY, format: 'json', ...params});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {signal: controller.signal});
    let data;
    try {
      data = await response.json();
    } catch {
      throw new LastfmError(null, `HTTP ${response.status}`);
    }
    if (data.error) {
      throw new LastfmError(data.error, data.message);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LastfmError(null, 'timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function lastfm(method, params, run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await throttled(() => {
        if (run && run !== currentRun) {
          return Promise.reject(new Cancelled());
        }
        return lastfmOnce(method, params);
      });
    } catch (err) {
      const retryable = !(err instanceof LastfmError) ||
                        err.code === null || RETRYABLE_ERRORS.has(err.code);
      if (err instanceof Cancelled || !retryable || attempt >= RETRIES) {
        throw err;
      }
      await sleep(err.code === 29 ? 5000 : 1000 * attempt);
    }
  }
}


// Charts of past weeks never change, so they are cached in IndexedDB.
const cache = {
  _db: null,

  open() {
    if (this._db === null) {
      this._db = new Promise((resolve, reject) => {
        const request = indexedDB.open('elaboratecharts', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(() => null);
    }
    return this._db;
  },

  async request(mode, action) {
    try {
      const db = await this.open();
      if (db === null) {
        return undefined;
      }
      return await new Promise((resolve, reject) => {
        const request = action(db.transaction('kv', mode).objectStore('kv'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return undefined;
    }
  },

  get(key) {
    return this.request('readonly', (store) => store.get(key));
  },

  set(key, value) {
    return this.request('readwrite', (store) => store.put(value, key));
  },
};


async function getRegistered(username, run) {
  const key = `${username.toLowerCase()}:registered`;
  const cached = await cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const info = await lastfm('user.getinfo', {user: username}, run);
  const registered = parseInt(info.user.registered.unixtime, 10);
  cache.set(key, registered);
  return registered;
}

async function getWeeklyChart(username, chartType, fromDate, toDate, run) {
  const key = `${username.toLowerCase()}:${chartType}:${fromDate}_${toDate}`;
  // Scrobbles may arrive late, so cache only weeks that ended a day ago.
  const isFinished = toDate + DAY < Date.now() / 1000;
  if (isFinished) {
    const cached = await cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  const response = await lastfm(`user.getweekly${chartType}chart`,
                                {user: username, from: fromDate, to: toDate}, run);
  let items = response[`weekly${chartType}chart`]?.[chartType] ?? [];
  if (!Array.isArray(items)) {
    items = [items];
  }
  const chart = {};
  for (const item of items) {
    chart[chartKey(chartType, item)] = parseInt(item.playcount, 10);
  }

  if (isFinished) {
    cache.set(key, chart);
  }
  return chart;
}

function chartKey(chartType, item) {
  if (chartType === 'artist') {
    return item.name;
  }
  return `${item.artist['#text']} – ${item.name}`;
}


// Last.fm weeks start on Sunday at 12:00 UTC.
function startOfChartWeek(date) {
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(),
                         date.getUTCDate() - date.getUTCDay());
  return start / 1000 + 12 * HOUR;
}

function subtractMonths(date, months) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

function getFromDate(timeframe, now, registered) {
  switch (timeframe) {
    case 'last-7-days': return new Date(now - 2 * WEEK * 1000);
    case 'last-month': return subtractMonths(now, 2);
    case 'last-3-months': return subtractMonths(now, 6);
    case 'last-6-months': return subtractMonths(now, 12);
    case 'last-12-months': return subtractMonths(now, 24);
    case 'overall': return new Date(registered * 1000);
  }
  throw new Error(`Unknown timeframe: ${timeframe}`);
}

function weekRanges(start, end) {
  const result = [];
  for (let s = start; s < end; s += WEEK) {
    result.push([s, Math.min(end, s + WEEK)]);
  }
  return result;
}


// For every week, sum the charts in a sliding window that spans half of the
// requested period (or everything since the start for "overall"), then keep
// the top positions.
function buildSeries(charts, {timeframe, numberOfPositions}) {
  const start = charts[0].toDate;
  const end = charts[charts.length - 1].toDate;
  const span = timeframe === 'overall' ? end - start : Math.floor((end - start) / 2);

  const totals = {};
  const weeklyTops = [];
  let tail = 0;
  for (const {toDate, chart} of charts) {
    for (const [item, count] of Object.entries(chart ?? {})) {
      totals[item] = (totals[item] ?? 0) + count;
    }
    while (charts[tail].toDate < toDate - span) {
      for (const [item, count] of Object.entries(charts[tail].chart ?? {})) {
        totals[item] -= count;
        if (totals[item] <= 0) {
          delete totals[item];
        }
      }
      tail += 1;
    }
    const top = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, numberOfPositions);
    weeklyTops.push({toDate, top: Object.fromEntries(top)});
  }

  // Order series by their last count in the top so that stacking is stable.
  const lastCounts = {};
  for (const {top} of weeklyTops) {
    Object.assign(lastCounts, top);
  }
  const items = Object.keys(lastCounts).sort((a, b) => lastCounts[a] - lastCounts[b]);

  // Show only the last half; the first half just primes the sliding window.
  const shown = timeframe === 'overall'
    ? weeklyTops
    : weeklyTops.slice(Math.floor(-weeklyTops.length / 2));

  return items.map((item) => ({
    name: item,
    data: shown.map(({toDate, top}) => [toDate * 1000, top[item] ?? 0]),
  }));
}

function escapeHTML(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let chart = null;

function drawChart(charts, params) {
  const series = buildSeries(charts, params);
  if (chart !== null) {
    chart.destroy();
  }
  chart = Highcharts.chart('chart', {
    chart: {type: 'area'},
    title: {text: null},
    credits: {enabled: false},
    xAxis: {
      type: 'datetime',
      tickmarkPlacement: 'on',
      title: {enabled: false},
      labels: {enabled: false},
    },
    yAxis: {title: {text: 'Percent'}},
    legend: {enabled: false},
    tooltip: {
      shared: true,
      formatter() {
        const hoverSeries = this.points[0]?.series.chart.hoverSeries;
        const points = this.points
          .filter((point) => point.y > 0)
          .sort((a, b) => b.y - a.y)
          .slice(0, params.numberOfPositions);
        let s = `<span style="font-size: 10px">${Highcharts.dateFormat('%A, %b %e, %Y', this.x)}</span>`;
        points.forEach((point, index) => {
          const position = String(index + 1).padStart(2, '0');
          const name = escapeHTML(point.series.name);
          const label = point.series === hoverSeries ? `<b>${name}</b>` : name;
          s += `<br/>${position} <span style="color: ${point.series.color};">●</span> ${label}: <b>${point.y}</b>`;
        });
        return s;
      },
    },
    plotOptions: {
      area: {
        stacking: 'percent',
        lineColor: '#ffffff',
        lineWidth: 1,
        marker: {enabled: false},
      },
      series: {animation: series.length <= 100},
    },
    series,
  });
}


function setCollapsed(collapsed) {
  $('#settings-block').classList.toggle('collapsed', collapsed);
}

function hideAlert() {
  $('#alert').hidden = true;
}

function showAlert(type, reason, message) {
  const alert = $('#alert');
  alert.className = `alert alert-${type}`;
  $('#alert-reason').textContent = reason;
  $('#alert-message').textContent = message;
  alert.hidden = false;
}

function setUsernameError(hasError) {
  $('#username').parentElement.classList.toggle('has-error', hasError);
}

function setProgress(fraction) {
  $('#submit .progress').style.width = `${fraction * 100}%`;
}

function setLoading(loading) {
  const button = $('#submit');
  button.disabled = loading;
  button.querySelector('.label').textContent = loading ? 'Loading…' : 'Submit';
  setProgress(0);
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}


function readParams() {
  const query = new URLSearchParams(location.search);
  const params = {};
  for (const [name, value] of Object.entries(DEFAULTS)) {
    params[name] = query.get(name) ?? value;
  }
  return params;
}

function fillForm(params) {
  for (const [name, value] of Object.entries(params)) {
    $(`#${name}`).value = value;
  }
}

function formParams() {
  const params = {};
  for (const name of Object.keys(DEFAULTS)) {
    params[name] = $(`#${name}`).value.trim();
  }
  return params;
}

let currentRun = null;

async function submit(params) {
  const run = {};
  currentRun = run;
  const username = params['username'];
  const options = {
    chartType: params['chart-type'],
    numberOfPositions: parseInt(params['number-of-positions'], 10),
    timeframe: params['timeframe'],
  };

  setLoading(true);
  hideAlert();

  try {
    const registered = await getRegistered(username, run);
    setUsernameError(false);

    const now = new Date();
    const fromDate = startOfChartWeek(getFromDate(options.timeframe, now, registered));
    // Load the most recent weeks first.
    const ranges = weekRanges(fromDate, Math.floor(now / 1000)).reverse();
    let progress = 0;
    const charts = await Promise.all(ranges.map(async ([from, to]) => {
      const result = {toDate: to};
      try {
        result.chart = await getWeeklyChart(username, options.chartType, from, to, run);
      } catch (err) {
        if (err instanceof Cancelled) {
          throw err;
        }
        console.error(`Failed to get chart for ${new Date(to * 1000).toISOString()}:`, err);
        result.error = err.message;
      }
      progress += 1;
      if (run === currentRun) {
        setProgress(progress / ranges.length);
      }
      return result;
    }));
    if (run !== currentRun) {
      return;
    }
    charts.reverse();

    if (charts.length === 0) {
      showAlert('warning', 'Nothing to show', 'There are no weeks in this timeframe yet.');
      return;
    }

    const failedWeeks = charts.filter(({error}) => error !== undefined)
      .map(({toDate}) => formatDate(toDate));
    if (failedWeeks.length > 0) {
      showAlert('warning', 'Last.fm Error',
                `Weeks ending on ${failedWeeks.join(', ')} failed to load.`);
    }

    drawChart(charts, options);
    if (failedWeeks.length === 0) {
      setCollapsed(true);
    }
  } catch (err) {
    if (err instanceof Cancelled || run !== currentRun) {
      return;
    }
    console.error(err);
    if (err instanceof LastfmError && err.code === 6) {
      setUsernameError(true);
      showAlert('danger', 'Last.fm Error', 'No such user exists.');
    } else if (err instanceof LastfmError) {
      showAlert('danger', 'Last.fm Error', err.message);
    } else {
      showAlert('danger', 'Network Error', 'Failed to get weekly charts.');
    }
  } finally {
    if (run === currentRun) {
      setLoading(false);
    }
  }
}


function initShare() {
  const button = $('.btn-share');
  const popover = $('.popover');
  const input = popover.querySelector('input');

  button.addEventListener('click', () => {
    popover.hidden = !popover.hidden;
    if (!popover.hidden) {
      input.value = location.href;
      input.focus();
      input.select();
    }
  });
  input.addEventListener('click', () => input.select());
  window.addEventListener('click', (event) => {
    if (!event.target.closest('.share')) {
      popover.hidden = true;
    }
  });
}

function init() {
  const params = readParams();
  fillForm(params);

  $('#form').addEventListener('submit', (event) => {
    event.preventDefault();
    const params = formParams();
    const query = '?' + new URLSearchParams(params);
    if (query !== location.search) {
      history.pushState(null, '', query);
    }
    submit(params);
  });

  window.addEventListener('popstate', () => {
    const params = readParams();
    fillForm(params);
    if (params['username']) {
      submit(params);
    }
  });

  $('.navbar-toggle').addEventListener('click', () => {
    $('#settings-block').classList.toggle('collapsed');
  });

  initShare();

  if (params['username']) {
    submit(params);
  }
}

init();
