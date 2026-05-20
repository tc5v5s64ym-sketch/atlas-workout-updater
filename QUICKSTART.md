# 🚀 Quick Start - New Endpoints

Get started using the new Atlas backend features.

## Setup

1. **Ensure API key is set:**
   ```bash
   export ATLAS_API_KEY="your-api-key"
   ```

2. **Set API endpoint:**
   ```bash
   export API_URL="https://your-atlas-api.com"
   ```

## Common Tasks

### 1. Get a Session Summary
Returns exercises, sets, volume, quality score, and effort data.

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/session/20250517-AM-01/summary"
```

Response includes:
- `exercises`: list of unique exercises
- `total_sets`, `total_volume`
- `quality_score`: 0-5 rating
- `effort`: HR, duration, calories
- `quick_summary`: narrative description

### 2. Track Progress on a Lift

See how a specific lift (e.g., Bench Press) has improved over time.

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/exercises/BP/progress"
```

Response includes:
- `sessions`: all sessions where BP was performed
- `best_weight_over_time`: progression chart data
- `estimated_1rm_over_time`: estimated max progression
- `recent_trend`: "up", "flat", or "down"

### 3. Get Training Recommendations

What should you do for your next set on Bench Press?

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/recommend/next/BP"
```

Response includes:
- `recommendation`: specific guidance (weight, reps)
- `reasoning`: why that recommendation
- `last_working_sets`: recent performance data

### 4. Check Muscle Group Volume

How much volume did you do for each muscle group this week?

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/volume/muscle-groups?days=7"
```

Response:
```json
{
  "groups": [
    {"muscle_group": "Chest", "volume": 4250, "set_count": 12},
    {"muscle_group": "Back", "volume": 3840, "set_count": 11},
    {"muscle_group": "Legs", "volume": 6200, "set_count": 14}
  ]
}
```

### 5. Find All Workouts with Squats

Search for sessions where you did squats in the last 30 days.

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/search/sessions?liftCode=SQ&dateFrom=2025-04-17"
```

Response: list of session IDs and matching exercise rows.

### 6. See Recent Personal Records

What are your current bests for each lift?

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/prs/recent"
```

Response:
```json
{
  "prs": [
    {
      "liftCode": "BP",
      "bestWeightSet": {"weight": 275, "reps": 3, "date": "2025-05-15"},
      "bestRepSet": {"weight": 185, "reps": 12, "date": "2025-05-10"},
      "bestEstimated1RMSet": {"estimated_1rm": 315.7, "date": "2025-05-15"}
    }
  ]
}
```

### 7. Log Your Bodyweight

Track your weight over time.

```bash
curl -X POST -H "x-atlas-api-key: $ATLAS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2025-05-17",
    "weight": 240.5,
    "notes": "morning, fasted"
  }' \
  "$API_URL/api/bodyweight"
```

**Note:** Requires `Bodyweight` tab in your Google Sheet.

### 8. View Bodyweight Trends

See your weight progression and trend.

```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/bodyweight/history?days=90"
```

Response:
```json
{
  "entries": [
    {"date": "2025-05-01", "weight": 242.0, "notes": ""},
    {"date": "2025-05-17", "weight": 240.5, "notes": "morning, fasted"}
  ],
  "latest": {"date": "2025-05-17", "weight": 240.5},
  "average": 241.25,
  "trend": "down"
}
```

### 9. Preview Test Data (Admin)

See which rows are marked as test data (for cleanup).

```bash
curl -X POST -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/admin/preview-test-rows"
```

Response: lists rows with "test" in notes or session ID.

**⚠️ Important:** This endpoint only previews data. It does NOT delete anything.

---

## Quality Score Explained

The `quality_score` returned in session summaries is calculated as:

```
Score = 0 to 5 points

+1 point if total_sets >= 10
+1 point if duration >= 30 minutes
+1 point if average_hr >= 100
+1 point if unique exercises >= 3
+1 point if no validation warnings
```

Example:
- 12 sets + 45 min + 105 avg HR + 4 exercises + no warnings = **5/5** ✨
- 8 sets + 25 min + 95 avg HR + 2 exercises + warnings = **1/5**

---

## Filtering & Query Parameters

### Date Formats
All date parameters accept: `YYYY-MM-DD`
- Example: `2025-05-17`

### Time Windows
- `days=7` for weekly view
- `days=14` for 2-week view (default for volume)
- `days=30` for monthly view (default for bodyweight)
- `days=90` for quarterly view

### Search Filters (all optional)
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/search/sessions?liftCode=SQ&muscleGroup=Legs&dateFrom=2025-05-01&dateTo=2025-05-31"
```

---

## Response Format

All successful responses follow this pattern:

```json
{
  "status": "ok",
  "message": "Description of response",
  "data": {
    /* endpoint-specific data */
  }
}
```

Error responses:

```json
{
  "status": "error",
  "message": "Error description",
  "details": "Optional technical details"
}
```

---

## Common Errors

### 401 Unauthorized
Missing or invalid `x-atlas-api-key` header.

```bash
# ❌ Wrong
curl "$API_URL/api/session/123/summary"

# ✅ Correct
curl -H "x-atlas-api-key: $ATLAS_API_KEY" "$API_URL/api/session/123/summary"
```

### 400 Bad Request
Missing required parameters or invalid format.

```bash
# ❌ Invalid date format
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/search/sessions?dateFrom=05-17-2025"

# ✅ Correct format
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/search/sessions?dateFrom=2025-05-17"
```

### 400 Bodyweight Tab Missing
`POST /api/bodyweight` requires `Bodyweight` tab to exist.

```json
{
  "status": "error",
  "message": "Bodyweight tab is missing. Cannot append bodyweight entry."
}
```

---

## Tips & Tricks

### 1. Chain Recommendations
Get PR, then get recommendation:
```bash
# Step 1: See your PR
curl -H "x-atlas-api-key: $ATLAS_API_KEY" "$API_URL/api/prs/recent" \
  | jq '.data.prs[0].liftCode'

# Step 2: Get recommendation for next set
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/recommend/next/BP"
```

### 2. Export Session Data
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/session/20250517-AM-01/summary" \
  | jq '.' > session-20250517-AM-01.json
```

### 3. Monitor Quality Scores
```bash
# Get quality score for latest session
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/session/20250517-AM-01/summary" \
  | jq '.data.quality_score'
```

### 4. Track Progress Over Time
```bash
# Export progress data
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "$API_URL/api/exercises/BP/progress" \
  | jq '.data.best_weight_over_time' > bp-progress.json
```

---

## Rate Limiting

Currently **unlimited** (no rate limiting implemented).

---

For more details, see:
- [API_REFERENCE.md](API_REFERENCE.md) - Quick lookup
- [README.md](README.md) - Full documentation
- [EXPANSION_SUMMARY.md](EXPANSION_SUMMARY.md) - Implementation details
