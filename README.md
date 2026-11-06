# StaffShift Fairness — Staff Rota Planner

A fair, transparent, and intelligent weekly staff rota planning system built for small teams. It ensures business operating hours are covered without repeatedly assigning inconvenient shifts (such as late closing, early morning, and weekend duties) to the same individuals.

---

## Key Features

1. **Inconvenient Shift Tracking & Fairness Engine**:
   - Automatically detects inconvenient shifts:
     - 🌙 **Closing / Night shifts** (ending at or after 20:00 or starting after 19:00).
     - 🌅 **Early Opening shifts** (starting on or before 07:30).
     - 🏖️ **Weekend shifts** (Saturday & Sunday).
     - ⚡ **Custom Demanding shifts** (flagged manually with custom reason, e.g. solo rush).
   - Computes team-wide and individual **Fairness Scores** (0–100%) and warns managers if shift distribution becomes unbalanced.
   - Generates actionable rebalancing recommendations.

2. **Smart Fairness Assignment Suggester**:
   - In the shift scheduling modal, available staff members are ranked in real-time according to fairness equity.
   - Recommends staff with the fewest inconvenient shifts and fewest total hours.
   - Alerts if a selected staff member already carries a disproportionate closing or weekend load.

3. **Overlap Conflict Detection & Prevention**:
   - Real-time double-booking validation in both API and UI.
   - Returns a `409 Conflict` error if a shift overlaps an existing assignment for the same person on the same date.
   - Calendar cards and top banner clearly flag scheduling conflicts with one-click resolution.

4. **Operating Hours Coverage Visualizer**:
   - Configurable business operating hours (default 08:00 – 21:00).
   - Hour-by-hour timeline visualizer highlighting covered slots versus understaffed gaps.

5. **Staff Availability & Preference Matrix**:
   - Manage weekday availability (Sun–Sat).
   - Set max weekly hours caps.
   - Set inconvenient shift willingness preferences (`willing`, `neutral`, `prefer_not`).

6. **MongoDB Persistence with Dev File Store Fallback**:
   - Full Mongoose schema persistence for `Staff`, `Shift`, and `Settings`.
   - Automatic fallback to local persistent store (`backend/data/planner.json`) if MongoDB is not running locally.
   - `/api/health` indicates active storage mode.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Custom Responsive UI System.
- **Backend**: Node.js, Express 5, Mongoose / MongoDB persistence, CORS, Dotenv.
- **Testing**: Built-in automated API test suite (`npm test`).

---

## Getting Started

### 1. Quick Start (Root Directory)

You can install dependencies and run both frontend and backend concurrently with a single command:

```sh
# Install root dependencies
npm install

# Start both backend (port 5000) and frontend (Vite) concurrently
npm run dev
```

- Open the Vite frontend URL displayed in your terminal (usually `http://localhost:5173`).
- The backend API runs on `http://localhost:5000`.

### 2. Run Backend Separately

```sh
cd api/backend
npm run dev
```

- Ensure `.env` exists in `api/backend/` (see `api/backend/.env.example`).
- Default `PORT=5000`.
- Set `MONGO_URI=mongodb://127.0.0.1:27017/staffshift` to use MongoDB.

### 3. Run Frontend Separately

```sh
cd frontend
npm run dev
```

- Frontend listens on `http://localhost:5173`.
- The Vite development server proxies `/api` requests to `http://localhost:5000`.
- Set `VITE_API_URL` to an absolute API URL only when using a separate backend host.

### 4. Run Automated Tests

```sh
npm test
```

Verifies health, data seeding, staff CRUD, shift scheduling, overlap prevention (409 Conflict), smart suggester ranking, and operating hours coverage analysis.

## Deploy to Vercel

1. Import this repository into Vercel with the repository root as the project root.
2. Keep the build command as `npm run build --prefix frontend` and the output directory as `frontend/dist`. The included `vercel.json` routes `/api/*` to the Express function and serves the frontend.
3. Add `MONGO_URI` as a Vercel environment variable for Production (and Preview if needed). Use a MongoDB database reachable from Vercel; local file storage is not persistent in serverless deployments.
4. Deploy. The frontend calls `/api` on the same Vercel deployment, so `VITE_API_URL` is not required.

Do not commit `.env` files or planner data. Configure secrets in Vercel's project environment-variable settings.

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Returns server health, active storage mode (`mongodb` / `file`), and feature flags. |
| `GET` | `/api/staff` | List all staff members sorted alphabetically with availability and preferences. |
| `POST` | `/api/staff` | Create a new team member with availability weekdays, max hours, and preference. |
| `PUT` | `/api/staff/:id` | Update team member name, role, availability days, max hours, or preferences. |
| `DELETE` | `/api/staff/:id` | Remove a staff member and their assigned shifts. |
| `GET` | `/api/shifts` | Query shifts with optional `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&staffId=...`. |
| `POST` | `/api/shifts` | Create a shift. Validates availability, dates, times, and flags overlaps. |
| `PUT` | `/api/shifts/:id` | Update a shift date, times, staff assignment, or notes. |
| `DELETE` | `/api/shifts/:id` | Remove a scheduled shift. |
| `POST` | `/api/shifts/suggest-staff` | Returns staff ranked by fairness equity for a given date/time slot. |
| `GET` | `/api/summary` | Returns individual and team fairness metrics, inconvenient shift tallies, and suggestions. |
| `GET` | `/api/coverage` | Returns operating hours coverage timeline and uncovered gaps for a date range. |
| `GET` | `/api/operating-hours` | Get target store operating hours. |
| `PUT` | `/api/operating-hours` | Update target operating opening and closing times. |
| `POST` | `/api/seed` | Loads realistic sample team members and a balanced weekly rota for demo/testing. |

---

## License

ISC
