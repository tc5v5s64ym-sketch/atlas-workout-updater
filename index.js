const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { appendRows, validateConfig, logSheetName, effortSheetName } = require('./sheets');

validateConfig();

const app = express();
app.use(express.json());

app.post('/api/log-workout', async (req, res) => {
  const { session_id, date, log_rows, effort_row } = req.body || {};

  console.log('Received payload:', { session_id, date, log_rows, effort_row });

  if (!session_id || !date || !Array.isArray(log_rows)) {
    return res.status(400).json({
      error: 'Invalid payload. Required fields: session_id, date, log_rows (array).'
    });
  }

  if (log_rows.length === 0) {
    return res.status(400).json({ error: 'log_rows must contain at least one row.' });
  }

  if (!effort_row) {
    console.warn('⚠️  WARNING: effort_row is missing or null');
    return res.status(400).json({
      error: 'Invalid payload. Required field: effort_row (array).'
    });
  }

  if (!Array.isArray(effort_row)) {
    console.error('❌ ERROR: effort_row is not an array. Received:', typeof effort_row, effort_row);
    return res.status(400).json({
      error: 'Invalid payload. effort_row must be an array.'
    });
  }

  if (effort_row.length === 0) {
    console.error('❌ ERROR: effort_row is empty.');
    return res.status(400).json({ error: 'effort_row must contain at least one element.' });
  }

  try {
    console.log('📝 Appending log_rows to', logSheetName, 'tab:', log_rows);
    const logResponse = await appendRows(logSheetName, log_rows);
    console.log('✅ Log rows appended successfully. Range:', logResponse.data.updates?.updatedRange);

    console.log('\n🔍 DEBUG: Effort row details:');
    console.log('   - effort_row exists:', !!effort_row);
    console.log('   - effort_row is array:', Array.isArray(effort_row));
    console.log('   - effort_row length:', effort_row.length);
    console.log('   - effort_row value:', effort_row);
    console.log('   - about to call appendRows with:', [effortSheetName, [effort_row]]);
    
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
