const express = require('express');

const router = express.Router();

let railkitModulePromise = null;
const trainCache = new Map();
const TRAIN_CACHE_TTL_MS = 60 * 1000;

async function getRailKit() {
  if (!process.env.RAILKIT_API_KEY) {
    const err = new Error('Railway service is not configured. Add RAILKIT_API_KEY in Render.');
    err.code = 'RAILWAY_NOT_CONFIGURED';
    throw err;
  }

  if (!railkitModulePromise) {
    railkitModulePromise = import('railkit').then((mod) => {
      if (typeof mod.configure !== 'function') {
        throw new Error('RailKit SDK is unavailable or incompatible.');
      }
      mod.configure(process.env.RAILKIT_API_KEY);
      return mod;
    });
  }

  return railkitModulePromise;
}

function fail(res, status, message, requestId) {
  return res.status(status).json({
    success: false,
    error: message,
    requestId,
  });
}

function validPnr(pnr) {
  return /^\d{10}$/.test(String(pnr || '').replace(/\D/g, ''));
}

function validTrain(trainNumber) {
  return /^\d{5}$/.test(String(trainNumber || '').trim());
}

function validDate(date) {
  return /^\d{2}-\d{2}-\d{4}$/.test(String(date || '').trim());
}

router.get('/pnr', async (req, res) => {
  const pnr = String(req.query.pnr || '').replace(/\D/g, '');
  if (!validPnr(pnr)) return fail(res, 400, 'PNR must be exactly 10 digits.', req.requestId);

  try {
    const { checkPNRStatus } = await getRailKit();
    const result = await checkPNRStatus(pnr);

    if (!result || result.success === false) {
      return fail(res, 502, result?.error || 'Unable to fetch PNR status.', req.requestId);
    }

    // Do not log or persist the PNR or passenger details.
    return res.json(result);
  } catch (err) {
    console.error(`[${req.requestId || 'unknown'}] railway PNR request failed`, err.message || err);
    if (err.code === 'RAILWAY_NOT_CONFIGURED') {
      return fail(res, 503, err.message, req.requestId);
    }
    return fail(res, 502, 'Railway PNR service is temporarily unavailable.', req.requestId);
  }
});

router.get('/train/:trainNumber/live', async (req, res) => {
  const trainNumber = String(req.params.trainNumber || '').trim();
  const date = String(req.query.date || '').trim();

  if (!validTrain(trainNumber)) {
    return fail(res, 400, 'Train number must be exactly 5 digits.', req.requestId);
  }
  if (!validDate(date)) {
    return fail(res, 400, 'Journey date must be DD-MM-YYYY.', req.requestId);
  }

  const cacheKey = `${trainNumber}:${date}`;
  const cached = trainCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRAIN_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const { trackTrain } = await getRailKit();
    const result = await trackTrain(trainNumber, date);

    if (!result || result.success === false) {
      return fail(res, 502, result?.error || 'Unable to fetch live train status.', req.requestId);
    }

    trainCache.set(cacheKey, { at: Date.now(), data: result });
    return res.json(result);
  } catch (err) {
    console.error(`[${req.requestId || 'unknown'}] railway train request failed`, err.message || err);
    if (err.code === 'RAILWAY_NOT_CONFIGURED') {
      return fail(res, 503, err.message, req.requestId);
    }
    return fail(res, 502, 'Live train service is temporarily unavailable.', req.requestId);
  }
});

module.exports = router;
