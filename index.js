const express = require('express');
const { appendRows, validateConfig } = require('./sheets');
const dotenv = require('dotenv');

dotenv.config();
validateConfig();

const app = express();
app.use(express.json());

app.post('/api/log-workout', async (req, res) => {
  const { session_id, date, log_rows, effort_row } = req.body || {};

  if (!session_id || !date || !Array.isArray(log_rows) || !Array.isArray(effort_row)) {
    return res.status(400).json({
      error: 'Invalid payload. Required fields: session_id, date, log_rows (array), effort_row (array).'
    });
  }

  if (log_rows.length === 0) {
    return res.status(400).json({ error: 'log_rows must contain at least one row.' });
  }

  try {
    const logResponse = await appendRows('Log', log_rows);
    const effortResponse = await appendRows('Effort', [effort_row]);

    return res.status(200).json({
      message: 'Workout data appended successfully.',
      logAppendedRange: logResponse.data.updates?.updatedRange,
      effortAppendedRange: effortResponse.data.updates?.updatedRange
    });
  } catch (error) {
    console.error('Failed to append workout data:', error);
    return res.status(500).json({ error: 'Failed to append workout data.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Atlas Workout Updater listening on port ${port}`);
});
