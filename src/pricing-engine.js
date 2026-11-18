'use strict';

const DEFAULT_FX_CNY = 7.20;

const MODEL_RATE_CATALOG = [
  {
    match: /claude.*opus/i,
    key: 'claude-opus',
    label: 'Claude Opus',
    contextLimit: 200_000,
    tiers: [{ maxPrompt: Infinity, input: 15.0, cache: 1.5, output: 75.0 }]
  },
  {
    match: /claude.*haiku/i,
    key: 'claude-haiku',
    label: 'Claude Haiku',
    contextLimit: 200_000,
    tiers: [{ maxPrompt: Infinity, input: 0.8, cache: 0.08, output: 4.0 }]
  },
  {
    match: /claude/i,
    key: 'claude-sonnet',
    label: 'Claude Sonnet',
    contextLimit: 200_000,
    tiers: [{ maxPrompt: Infinity, input: 3.0, cache: 0.3, output: 15.0 }]
  },
  {
    match: /flash.*lite/i,
    key: 'gemini-flash-lite',
    label: 'Gemini Flash Lite',
    contextLimit: 524_288,
    physicalLimit: 1_048_576,
    tiers: [{ maxPrompt: Infinity, input: 0.1, cache: 0.025, output: 0.4 }]
  },
  {
    match: /flash/i,
    key: 'gemini-flash',
    label: 'Gemini Flash',
    contextLimit: 524_288,
    physicalLimit: 1_048_576,
    tiers: [{ maxPrompt: Infinity, input: 0.3, cache: 0.075, output: 2.5 }]
  },
  {
    match: /carbon/i,
    key: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    contextLimit: 524_288,
    physicalLimit: 1_048_576,
    tiers: [
      { maxPrompt: 200_000, input: 1.5, cache: 0.1, output: 10.0 },
      { maxPrompt: Infinity, input: 2.5, cache: 0.2, output: 15.0 }
    ]
  },
  {
    match: /gemini|pro|argon|hydrogen/i,
    key: 'gemini-pro',
    label: 'Gemini Pro',
    contextLimit: 524_288,
    physicalLimit: 1_048_576,
    tiers: [
      { maxPrompt: 200_000, input: 1.25, cache: 0.125, output: 10.0 },
      { maxPrompt: Infinity, input: 2.5, cache: 0.25, output: 15.0 }
    ]
  },
  {
    match: /gpt-4o-mini|gpt-5-mini/i,
    key: 'gpt-mini',
    label: 'GPT Mini',
    contextLimit: 400_000,
    tiers: [{ maxPrompt: Infinity, input: 0.25, cache: 0.025, output: 2.0 }]
  },
  {
    match: /gpt|o1|o3|o4/i,
    key: 'gpt-flagship',
    label: 'GPT Flagship',
    contextLimit: 400_000,
    tiers: [{ maxPrompt: Infinity, input: 2.5, cache: 0.25, output: 10.0 }]
  }
];

const FALLBACK_SPEC = {
  key: 'gemini-4-carbon',
  label: 'Gemini 4 Carbon',
  contextLimit: 524_288,
  physicalLimit: 1_048_576,
  tiers: [
    { maxPrompt: 200_000, input: 1.5, cache: 0.1, output: 10.0 },
    { maxPrompt: Infinity, input: 2.5, cache: 0.2, output: 15.0 }
  ]
};

function resolveModelSpec(rawModel) {
  const clean = String(rawModel || '').trim();
  if (!clean) return { ...FALLBACK_SPEC, displayLabel: FALLBACK_SPEC.label };
  for (const spec of MODEL_RATE_CATALOG) {
    if (spec.match.test(clean)) {
      return { ...spec, displayLabel: clean };
    }
  }
  return { ...FALLBACK_SPEC, displayLabel: clean };
}

function pickRateTier(spec, totalPromptTokens) {
  const prompt = Math.max(0, Number(totalPromptTokens) || 0);
  for (const tier of spec.tiers) {
    if (prompt <= tier.maxPrompt) return tier;
  }
  return spec.tiers[spec.tiers.length - 1];
}

function roundMoney(val) {
  const n = Number(val) || 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function calcStepCost(usage = {}, rawModel = '', fxCny = DEFAULT_FX_CNY) {
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);

  const spec = resolveModelSpec(rawModel);
  const tier = pickRateTier(spec, inputTokens + cacheReadTokens);

  const inputUSD = (inputTokens / 1_000_000) * tier.input;
  const cacheUSD = (cacheReadTokens / 1_000_000) * tier.cache;
  const outputUSD = (outputTokens / 1_000_000) * tier.output;
  const totalUSD = inputUSD + cacheUSD + outputUSD;
  const savedUSD = Math.max(0, (cacheReadTokens / 1_000_000) * (tier.input - tier.cache));
  const fx = Number(fxCny) > 0 ? Number(fxCny) : DEFAULT_FX_CNY;

  return {
    modelKey: spec.key,
    modelLabel: spec.displayLabel || spec.label,
    inputUSD: roundMoney(inputUSD),
    cacheUSD: roundMoney(cacheUSD),
    outputUSD: roundMoney(outputUSD),
    totalUSD: roundMoney(totalUSD),
    savedUSD: roundMoney(savedUSD),
    totalCNY: roundMoney(totalUSD * fx),
    savedCNY: roundMoney(savedUSD * fx)
  };
}

function createEmptyAggregate(fx) {
  return {
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    steps: 0,
    activeDays: 0,
    sessionsCount: 0,
    cacheHitRate: 0,
    cost: {
      inputUSD: 0,
      cacheUSD: 0,
      outputUSD: 0,
      totalUSD: 0,
      savedUSD: 0,
      totalCNY: 0,
      savedCNY: 0,
      dailyAvgUSD: 0,
      fx
    }
  };
}

function finalizeAggregate(agg, sessionSet) {
  agg.sessionsCount = sessionSet.size;
  const promptTotal = agg.inputTokens + agg.cacheTokens;
  agg.cacheHitRate = promptTotal > 0 ? Number(((agg.cacheTokens / promptTotal) * 100).toFixed(1)) : 0;
  agg.cost.inputUSD = roundMoney(agg.cost.inputUSD);
  agg.cost.cacheUSD = roundMoney(agg.cost.cacheUSD);
  agg.cost.outputUSD = roundMoney(agg.cost.outputUSD);
  agg.cost.totalUSD = roundMoney(agg.cost.totalUSD);
  agg.cost.savedUSD = roundMoney(agg.cost.savedUSD);
  agg.cost.totalCNY = roundMoney(agg.cost.totalUSD * agg.cost.fx);
  agg.cost.savedCNY = roundMoney(agg.cost.savedUSD * agg.cost.fx);
  agg.cost.dailyAvgUSD = agg.activeDays > 0 ? roundMoney(agg.cost.totalUSD / agg.activeDays) : 0;
  return agg;
}

function computeBucketCost(dayBucket, fx) {
  let inputUSD = 0;
  let cacheUSD = 0;
  let outputUSD = 0;
  let savedUSD = 0;

  const modelEntries = dayBucket.models ? Object.entries(dayBucket.models) : [];
  if (modelEntries.length > 0) {
    for (const [mKey, mVal] of modelEntries) {
      const avgPrompt = mVal.steps > 0 ? (mVal.input + mVal.cache) / mVal.steps : (mVal.input + mVal.cache);
      const spec = resolveModelSpec(mVal.label || mKey);
      const tier = pickRateTier(spec, avgPrompt);
      inputUSD += (mVal.input / 1_000_000) * tier.input;
      cacheUSD += (mVal.cache / 1_000_000) * tier.cache;
      outputUSD += (mVal.output / 1_000_000) * tier.output;
      savedUSD += Math.max(0, (mVal.cache / 1_000_000) * (tier.input - tier.cache));
    }
  } else {
    const c = calcStepCost(
      { inputTokens: dayBucket.input, cacheReadTokens: dayBucket.cache, outputTokens: dayBucket.output },
      '',
      fx
    );
    inputUSD = c.inputUSD;
    cacheUSD = c.cacheUSD;
    outputUSD = c.outputUSD;
    savedUSD = c.savedUSD;
  }

  const totalUSD = inputUSD + cacheUSD + outputUSD;
  return {
    inputUSD,
    cacheUSD,
    outputUSD,
    totalUSD,
    savedUSD,
    totalCNY: totalUSD * fx
  };
}

function addDayToAggregate(agg, sessionSet, dayBucket, dayCost) {
  const dayTotal = (dayBucket.input || 0) + (dayBucket.cache || 0) + (dayBucket.output || 0);
  if (dayTotal <= 0) return;

  agg.inputTokens += dayBucket.input || 0;
  agg.cacheTokens += dayBucket.cache || 0;
  agg.outputTokens += dayBucket.output || 0;
  agg.totalTokens += dayTotal;
  agg.steps += dayBucket.steps || 0;
  agg.activeDays += 1;

  if (dayBucket.sessions) {
    for (const s of dayBucket.sessions) sessionSet.add(s);
  }

  agg.cost.inputUSD += dayCost.inputUSD;
  agg.cost.cacheUSD += dayCost.cacheUSD;
  agg.cost.outputUSD += dayCost.outputUSD;
  agg.cost.totalUSD += dayCost.totalUSD;
  agg.cost.savedUSD += dayCost.savedUSD;
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function summarizeBuckets(dailyBuckets = {}, options = {}) {
  const fx = Number(options.fxCny) > 0 ? Number(options.fxCny) : DEFAULT_FX_CNY;
  const todayStr = options.todayDate || formatLocalDate(new Date());
  const monthPrefix = todayStr.slice(0, 7);
  const yearPrefix = todayStr.slice(0, 4);
  const minDate = options.minDate || null;

  const todayAgg = createEmptyAggregate(fx);
  const monthAgg = createEmptyAggregate(fx);
  const yearAgg = createEmptyAggregate(fx);
  const allAgg = createEmptyAggregate(fx);

  const sToday = new Set();
  const sMonth = new Set();
  const sYear = new Set();
  const sAll = new Set();

  const modelBreakdownMap = new Map();
  let firstActiveDate = null;

  const sortedDates = Object.keys(dailyBuckets).sort();
  for (const dateKey of sortedDates) {
    if (minDate && dateKey < minDate) continue;
    const bucket = dailyBuckets[dateKey];
    if (!bucket) continue;
    const dayTokens = (bucket.input || 0) + (bucket.cache || 0) + (bucket.output || 0);
    if (dayTokens <= 0) continue;

    if (!firstActiveDate) firstActiveDate = dateKey;
    const dayCost = computeBucketCost(bucket, fx);

    addDayToAggregate(allAgg, sAll, bucket, dayCost);
    if (dateKey.startsWith(yearPrefix)) addDayToAggregate(yearAgg, sYear, bucket, dayCost);
    if (dateKey.startsWith(monthPrefix)) addDayToAggregate(monthAgg, sMonth, bucket, dayCost);
    if (dateKey === todayStr) addDayToAggregate(todayAgg, sToday, bucket, dayCost);

    if (bucket.models) {
      for (const [mKey, mVal] of Object.entries(bucket.models)) {
        const cur = modelBreakdownMap.get(mKey) || {
          key: mKey,
          label: mVal.label || mKey,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          steps: 0,
          totalUSD: 0
        };
        cur.inputTokens += mVal.input || 0;
        cur.cacheTokens += mVal.cache || 0;
        cur.outputTokens += mVal.output || 0;
        cur.totalTokens += (mVal.input || 0) + (mVal.cache || 0) + (mVal.output || 0);
        cur.steps += mVal.steps || 0;
        const mCost = calcStepCost(
          { inputTokens: mVal.input, cacheReadTokens: mVal.cache, outputTokens: mVal.output },
          mVal.label || mKey,
          fx
        );
        cur.totalUSD = roundMoney(cur.totalUSD + mCost.totalUSD);
        modelBreakdownMap.set(mKey, cur);
      }
    }
  }

  const byModel = Array.from(modelBreakdownMap.values()).sort((a, b) => b.totalUSD - a.totalUSD);

  return {
    todayDate: todayStr,
    firstActiveDate: firstActiveDate || todayStr,
    fxCny: fx,
    today: finalizeAggregate(todayAgg, sToday),
    month: finalizeAggregate(monthAgg, sMonth),
    year: finalizeAggregate(yearAgg, sYear),
    allTime: finalizeAggregate(allAgg, sAll),
    byModel
  };
}

function buildHeatmapGrid(dailyBuckets = {}, options = {}) {
  const weeksCount = Number(options.weeks) > 0 ? Number(options.weeks) : 52;
  const fx = Number(options.fxCny) > 0 ? Number(options.fxCny) : DEFAULT_FX_CNY;
  const minDate = options.minDate || null;
  const endStr = options.endDate || formatLocalDate(new Date());

  const [ey, em, ed] = endStr.split('-').map(Number);
  const endDate = new Date(ey, em - 1, ed);
  // 对齐到本周六作为最后一列的末尾（周日为每列第 0 行）
  const endDow = endDate.getDay();
  const gridEnd = new Date(endDate);
  gridEnd.setDate(gridEnd.getDate() + (6 - endDow));

  const totalDays = weeksCount * 7;
  const gridStart = new Date(gridEnd);
  gridStart.setDate(gridEnd.getDate() - (totalDays - 1));

  let maxDailyTokens = 0;
  const rawCells = [];

  for (let i = 0; i < totalDays; i++) {
    const cur = new Date(gridStart);
    cur.setDate(gridStart.getDate() + i);
    const dStr = formatLocalDate(cur);
    const isFuture = dStr > endStr;
    const isFiltered = Boolean(minDate && dStr < minDate);
    const bucket = (!isFuture && !isFiltered) ? dailyBuckets[dStr] : null;
    const totalTokens = bucket ? ((bucket.input || 0) + (bucket.cache || 0) + (bucket.output || 0)) : 0;
    const costUSD = (bucket && totalTokens > 0) ? roundMoney(computeBucketCost(bucket, fx).totalUSD) : 0;

    if (totalTokens > maxDailyTokens) maxDailyTokens = totalTokens;
    rawCells.push({
      date: dStr,
      month: cur.getMonth() + 1,
      dayOfMonth: cur.getDate(),
      dow: cur.getDay(),
      isFuture,
      totalTokens,
      inputTokens: bucket?.input || 0,
      cacheTokens: bucket?.cache || 0,
      outputTokens: bucket?.output || 0,
      costUSD,
      costCNY: roundMoney(costUSD * fx)
    });
  }

  const weeks = [];
  let prevMonth = -1;
  for (let w = 0; w < weeksCount; w++) {
    const slice = rawCells.slice(w * 7, w * 7 + 7);
    const firstValid = slice.find(c => c.dayOfMonth <= 7) || slice[0];
    let monthLabel = '';
    if (firstValid.month !== prevMonth && firstValid.dayOfMonth <= 14) {
      monthLabel = `${firstValid.month}月`;
      prevMonth = firstValid.month;
    }
    const days = slice.map(cell => {
      let level = 0;
      if (cell.totalTokens > 0 && maxDailyTokens > 0) {
        const ratio = Math.sqrt(cell.totalTokens / maxDailyTokens);
        if (ratio >= 0.78) level = 4;
        else if (ratio >= 0.52) level = 3;
        else if (ratio >= 0.26) level = 2;
        else level = 1;
      }
      return { ...cell, level };
    });
    weeks.push({ index: w, monthLabel, days });
  }

  return {
    startDate: rawCells[0]?.date || endStr,
    endDate: endStr,
    maxDailyTokens,
    weeks
  };
}

module.exports = {
  DEFAULT_FX_CNY,
  resolveModelSpec,
  calcStepCost,
  summarizeBuckets,
  buildHeatmapGrid,
  formatLocalDate
};
