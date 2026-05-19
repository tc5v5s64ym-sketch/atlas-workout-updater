const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { appendRows, validateConfig, logSheetName, effortSheetName } = require('./sheets');

validateConfig();

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'atlas-workout-updater' });
});

app.post('/api/log-workout', async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload. A JSON object is required.' });
  }

  const { session_id, date, log_rows, effort_row } = payload;

  console.log('Received payload:', { session_id, date, log_rows, effort_row });

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  if (!date) {
    return res.status(400).json({ error: 'date is required.' });
  }

  if (log_rows === undefined) {
    return res.status(400).json({ error: 'log_rows is required.' });
  }

  if (!Array.isArray(log_rows)) {
    return res.status(400).json({ error: 'log_rows must be an array.' });
  }

  if (log_rows.length === 0) {
    return res.status(400).json({ error: 'log_rows must be a non-empty array.' });
  }

  if (effort_row === undefined) {
    return res.status(400).json({ error: 'effort_row is required.' });
  }

  if (!Array.isArray(effort_row)) {
    return res.status(400).json({ error: 'effort_row must be an array.' });
  }

  if (effort_row.length === 0) {
    return res.status(400).json({ error: 'effort_row must be a non-empty array.' });
  }

  try {
    console.log('📝 Appending log_rows to', logSheetName, 'tab:', log_rows);
    const logResponse = await appendRows(logSheetName, log_rows);
    console.log('✅ Log rows appended successfully. Range:', logResponse.data.updates?.updatedRange);

    console.log('\n📝 Appending effort_row to', effortSheetName, 'tab:', [effort_row]);
    const effortResponse = await appendRows(effortSheetName, [effort_row]);
    console.log('✅ Effort row appended successfully. Range:', effortResponse.data.updates?.updatedRange);

    return res.status(200).json({
      message: 'Workout data appended successfully.',
      logAppendedRange: logResponse.data.updates?.updatedRange,
      effortAppendedRange: effortResponse.data.updates?.updatedRange
    });
  } catch (error) {
    console.error('❌ Failed to append workout data:', error);
    return res.status(500).json({ error: 'Failed to append workout data.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Atlas Workout Updater listening on port ${port}`);
});
