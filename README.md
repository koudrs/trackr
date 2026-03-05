# CargoTracker

Air cargo AWB (Air Waybill) tracking system with real-time updates and connection/transshipment support.

**Powered by [Koudrs](https://koudrs.com)**

## Project Structure

```
cargotkr/
├── api/                    # Backend API (Python + FastAPI)
│   ├── carriers/           # Airline tracking modules
│   ├── main.py             # API entry point
│   └── models.py           # Data models
├── front-vite/             # Frontend (React 19 + Vite + TypeScript)
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom hooks
│   │   └── lib/            # Utilities and API client
│   └── docs/               # Technical documentation
├── Dockerfile              # Production container
├── requirements.txt        # Python dependencies
└── README.md               # This file
```

## Quick Start

### Backend (API)

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Linux/Mac
# .venv\Scripts\activate   # Windows

# Install dependencies
pip install -r requirements.txt
playwright install chromium

# Run API server
uvicorn api.main:app --reload --port 8000
```

### Frontend

```bash
cd front-vite

# Install dependencies
npm install

# Run development server
npm run dev
```

The frontend runs on `http://localhost:5173` and proxies API calls to `http://localhost:8000`.

## API Reference

### Track AWB

```
GET /api/track/{awb}
```

**Parameters:**
- `awb`: AWB number in format `XXX-XXXXXXXX` (e.g., `045-21930510`)

**Response:**

```json
{
  "awb": "045-21930510",
  "airline": "LATAM Cargo",
  "iata_code": "LA",
  "origin": "MIA",
  "destination": "PTY",
  "pieces": 42,
  "weight": 876.0,
  "status": "Shipment Received",
  "events": [
    {
      "timestamp": "2026-03-04T16:44:00",
      "status_code": "RCS",
      "description": "Shipment Received",
      "location": "MIA",
      "flight": null,
      "pieces": 42
    }
  ],
  "tracked_at": "2026-03-04T20:36:15.123Z",
  "source": "HTML"
}
```

### List Supported Carriers

```
GET /api/carriers
```

**Response:**

```json
[
  { "name": "LATAM Cargo", "iata_code": "LA", "prefixes": ["045"] },
  { "name": "Amerijet", "iata_code": "M6", "prefixes": ["810"] },
  ...
]
```

### Status Codes (IATA Standard)

| Code | Meaning | Description |
|------|---------|-------------|
| `BKD` | Booked | Booking confirmed |
| `RCS` | Received | Shipment received by airline |
| `MAN` | Manifested | Assigned to flight |
| `DEP` | Departed | Flight departed |
| `ARR` | Arrived | Flight arrived |
| `RCF` | Received from flight | At destination warehouse |
| `NFD` | Notified | Ready for pickup |
| `DLV` | Delivered | Delivered to consignee |

## Frontend Architecture

### Key Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Main layout, state management |
| `SearchBar.tsx` | AWB search input |
| `TrackingSidebar.tsx` | List of tracked AWBs (Departed/Arrived/Others) |
| `TrackingResult.tsx` | Shipment detail view |
| `FlightRadar.tsx` | Map showing active flights |
| `Dashboard.tsx` | Summary statistics |

### Main Hook: useTrackedAWBs

Located at `src/hooks/useTrackedAWBs.ts`. Manages all tracking state:

```typescript
const {
  trackedAWBs,        // Array of tracked AWBs
  addAWB,             // Add AWB to track
  removeAWB,          // Remove AWB
  refreshAWB,         // Refresh single AWB
  refreshAll,         // Refresh all AWBs
  clearAll,           // Clear all
  addConnection,      // Link two AWBs (transshipment)
  unlinkConnection,   // Unlink connection
} = useTrackedAWBs();
```

### Data Persistence

Currently uses `localStorage` with key `tracked_awbs`. Auto-refreshes every 5 minutes.

```typescript
interface TrackedAWB {
  awb: string;
  data: TrackingResult | null;
  lastUpdated: string;
  isLoading: boolean;
  error: string | null;
  connectionAWB?: string;  // Linked connection AWB
  parentAWB?: string;      // Parent AWB (if this is a connection)
}
```

### Connection/Transshipment Feature

For shipments with intermediate stops (e.g., Shanghai → Miami → Panama):

1. User adds primary AWB (PVG → MIA)
2. Clicks link icon on the AWB card
3. Enters connection AWB (MIA → PTY)
4. System creates bidirectional link

Display shows:
- "Primary" or "Connection" badge
- Full route: `PVG ✈ MIA → PTY`
- Clickable link to related AWB

## Environment Variables

### Frontend (`front-vite/.env`)

```env
VITE_API_URL=              # API base URL (empty = use Vite proxy)
VITE_TURNSTILE_SITE_KEY=   # Cloudflare Turnstile (optional)
```

### Backend (`.env`)

```env
RESEND_API_KEY=            # Resend API for email notifications
NOTIFY_FROM=               # From email address
NOTIFY_TO=                 # Notification recipient
```

## Docker Deployment

```bash
# Build image
docker build -t cargotracker:latest .

# Run container
docker run -d -p 3000:3000 --name cargotracker cargotracker:latest
```

The container runs:
- Frontend on port 3000 (exposed)
- API on port 8000 (internal)

## Database Migration Guide

To migrate from localStorage to a database, see [Database Migration Guide](front-vite/docs/CARGOTRACKER.md#guía-de-migración-a-base-de-datos).

### Suggested Schema (PostgreSQL)

```sql
-- Shipments table
CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  awb VARCHAR(20) UNIQUE NOT NULL,
  airline VARCHAR(100),
  iata_code VARCHAR(3),
  origin VARCHAR(3),
  destination VARCHAR(3),
  pieces INTEGER,
  weight DECIMAL(10,2),
  status VARCHAR(10),
  tracked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events table
CREATE TABLE shipment_events (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ,
  status_code VARCHAR(10) NOT NULL,
  description TEXT,
  location VARCHAR(3),
  flight VARCHAR(20),
  pieces INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connections table (for transshipments)
CREATE TABLE shipment_connections (
  id SERIAL PRIMARY KEY,
  parent_shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  connection_shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(parent_shipment_id, connection_shipment_id)
);

-- Indexes
CREATE INDEX idx_shipments_awb ON shipments(awb);
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_events_shipment ON shipment_events(shipment_id);
CREATE INDEX idx_events_timestamp ON shipment_events(timestamp DESC);
```

### Migration Steps

1. Create database tables (schema above)
2. Create API endpoints:
   - `POST /api/shipments` - Save/update shipment
   - `GET /api/shipments` - List user's shipments
   - `DELETE /api/shipments/{awb}` - Remove shipment
3. Update `useTrackedAWBs` hook:
   - Replace localStorage reads with API calls
   - Replace localStorage writes with API calls
   - Keep same interface for components

### Example: Saving to Database

```typescript
// Current (localStorage)
localStorage.setItem('tracked_awbs', JSON.stringify(trackedAWBs));

// With database
await fetch('/api/shipments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    awb: tracked.awb,
    ...tracked.data,
    connectionAWB: tracked.connectionAWB,
  })
});
```

### Example: Loading from Database

```typescript
// Current (localStorage)
const stored = localStorage.getItem('tracked_awbs');
const awbs = JSON.parse(stored || '[]');

// With database
const response = await fetch('/api/shipments');
const awbs = await response.json();
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, CSS Variables |
| Maps | react-leaflet, Leaflet |
| State | React Hooks |
| Backend | Python 3.12, FastAPI |
| Container | Docker (multi-stage build) |
