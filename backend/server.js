const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');

// Always load .env from the backend directory
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

const STAFF_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Default team operating hours (08:00 to 21:00 daily)
const DEFAULT_OPERATING_HOURS = {
  start: '08:00',
  end: '21:00',
  days: [0, 1, 2, 3, 4, 5, 6],
};

// Mongoose Models
const StaffSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
  role: { type: String, default: 'Team member', trim: true, maxlength: 60 },
  availability: {
    type: [{ type: Number, enum: STAFF_DAYS }],
    default: [1, 2, 3, 4, 5],
    validate: {
      validator: (days) => Array.isArray(days) && days.length > 0 && new Set(days).size === days.length,
      message: 'Availability days must be unique and non-empty.',
    },
  },
  maxWeeklyHours: { type: Number, default: 40, min: 1, max: 80 },
  color: { type: String, default: '#7b66e8' },
  inconvenientPreference: { type: String, enum: ['willing', 'neutral', 'prefer_not'], default: 'neutral' },
  notes: { type: String, default: '', maxlength: 200 },
}, { timestamps: true });

const ShiftSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  startTime: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  endTime: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  shiftType: {
    type: String,
    enum: ['standard', 'opening', 'closing', 'night', 'weekend', 'custom_inconvenient'],
    default: 'standard',
  },
  isInconvenient: { type: Boolean, default: false },
  inconvenientReason: { type: String, default: '' },
  notes: { type: String, default: '', maxlength: 200 },
}, { timestamps: true });

const SettingsSchema = new mongoose.Schema({
  operatingHours: {
    start: { type: String, default: '08:00' },
    end: { type: String, default: '21:00' },
  },
}, { timestamps: true });

const Staff = mongoose.model('Staff', StaffSchema);
const Shift = mongoose.model('Shift', ShiftSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

let storageMode = 'file'; // Default to file until initialized
let isInitialized = false;
let initPromise = null;
let localData = {
  staff: [],
  shifts: [],
  operatingHours: { ...DEFAULT_OPERATING_HOURS },
};
let pendingWrite = Promise.resolve();
const localDataPath = process.env.LOCAL_DB_FILE || path.join(__dirname, 'data', 'planner.json');

async function initStorage() {
  if (isInitialized) return storageMode;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const mongoUri = process.env.MONGO_URI;
    if (mongoUri) {
      try {
        await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 2000 });
        storageMode = 'mongodb';
        console.log(`Connected to MongoDB at ${mongoUri}`);
      } catch (error) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_FILE_FALLBACK === 'false') {
          throw new Error(`Unable to connect to MongoDB: ${error.message}`);
        }
        openLocalStore();
        console.warn(`MongoDB is unavailable; using development file storage at ${localDataPath}.`);
      }
    } else if (process.env.NODE_ENV === 'production' || process.env.ALLOW_FILE_FALLBACK === 'false') {
      throw new Error('MONGO_URI is required to start the planner API.');
    } else {
      openLocalStore();
      console.warn(`MONGO_URI is not configured; using development file storage at ${localDataPath}.`);
    }
    isInitialized = true;
    return storageMode;
  })();

  return initPromise;
}

// Ensure database/storage is ready before handling any request
app.use(async (req, res, next) => {
  if (!isInitialized) {
    try {
      await initStorage();
    } catch (err) {
      return next(err);
    }
  }
  next();
});

// Inconvenient Shift Detection Logic
function evaluateShiftInconvenience(date, startTime, endTime, explicitType, explicitFlag, explicitReason) {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const isEarly = startTime <= '07:30';
  const isClosing = endTime >= '20:00' || startTime >= '19:00';

  let shiftType = explicitType || 'standard';
  let isInconvenient = Boolean(explicitFlag);
  const reasons = [];

  if (isWeekend) {
    isInconvenient = true;
    if (shiftType === 'standard') shiftType = 'weekend';
    reasons.push('Weekend shift');
  }
  if (isEarly) {
    isInconvenient = true;
    if (shiftType === 'standard' || shiftType === 'weekend') shiftType = 'opening';
    reasons.push('Early morning start');
  }
  if (isClosing) {
    isInconvenient = true;
    if (shiftType === 'standard' || shiftType === 'weekend') shiftType = 'closing';
    reasons.push('Late closing hours');
  }
  if (explicitFlag) {
    isInconvenient = true;
    if (shiftType === 'standard') shiftType = 'custom_inconvenient';
    if (explicitReason && !reasons.includes(explicitReason)) {
      reasons.push(explicitReason);
    }
  }

  return {
    shiftType,
    isInconvenient,
    inconvenientReason: explicitReason || reasons.join(', ') || 'Standard shift',
  };
}

function parseTimeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function calculateShiftHours(startTime, endTime) {
  const startMins = parseTimeToMinutes(startTime);
  const endMins = parseTimeToMinutes(endTime);
  return Math.max(0, (endMins - startMins) / 60);
}

function openLocalStore() {
  try {
    fs.mkdirSync(path.dirname(localDataPath), { recursive: true });
    if (fs.existsSync(localDataPath)) {
      const saved = JSON.parse(fs.readFileSync(localDataPath, 'utf8'));
      if (!saved || !Array.isArray(saved.staff) || !Array.isArray(saved.shifts)) {
        throw new Error('The local planner data file has an invalid format.');
      }
      localData = {
        staff: saved.staff.map((s) => ({
          ...s,
          maxWeeklyHours: s.maxWeeklyHours || 40,
          inconvenientPreference: s.inconvenientPreference || 'neutral',
        })),
        shifts: saved.shifts.map((shift) => {
          const evalRes = evaluateShiftInconvenience(
            shift.date,
            shift.startTime,
            shift.endTime,
            shift.shiftType,
            shift.isInconvenient,
            shift.inconvenientReason
          );
          return {
            ...shift,
            shiftType: shift.shiftType || evalRes.shiftType,
            isInconvenient: shift.isInconvenient !== undefined ? shift.isInconvenient : evalRes.isInconvenient,
            inconvenientReason: shift.inconvenientReason || evalRes.inconvenientReason,
          };
        }),
        operatingHours: saved.operatingHours || { ...DEFAULT_OPERATING_HOURS },
      };
    } else {
      localData = {
        staff: [],
        shifts: [],
        operatingHours: { ...DEFAULT_OPERATING_HOURS },
      };
    }
    storageMode = 'file';
  } catch (error) {
    throw new Error(`Unable to open local planner data at ${localDataPath}: ${error.message}`);
  }
}

function saveLocalStore() {
  const contents = JSON.stringify(localData, null, 2);
  pendingWrite = pendingWrite.then(async () => {
    await fs.promises.mkdir(path.dirname(localDataPath), { recursive: true });
    const temporaryPath = `${localDataPath}.tmp`;
    await fs.promises.writeFile(temporaryPath, contents, 'utf8');
    await fs.promises.rename(temporaryPath, localDataPath);
  });
  return pendingWrite;
}

function localStaffResponse(person) {
  return {
    ...person,
    _id: person._id.toString(),
    maxWeeklyHours: person.maxWeeklyHours || 40,
    inconvenientPreference: person.inconvenientPreference || 'neutral',
  };
}

function localShiftResponse(shift, populateStaff = false) {
  const evalRes = evaluateShiftInconvenience(
    shift.date,
    shift.startTime,
    shift.endTime,
    shift.shiftType,
    shift.isInconvenient,
    shift.inconvenientReason
  );
  const response = {
    ...shift,
    _id: shift._id.toString(),
    staffId: shift.staffId.toString(),
    shiftType: shift.shiftType || evalRes.shiftType,
    isInconvenient: shift.isInconvenient !== undefined ? shift.isInconvenient : evalRes.isInconvenient,
    inconvenientReason: shift.inconvenientReason || evalRes.inconvenientReason,
    notes: shift.notes || '',
  };
  if (!populateStaff) return response;
  const person = localData.staff.find((entry) => entry._id.toString() === response.staffId);
  return { ...response, staffId: person ? localStaffResponse(person) : null };
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function isAvailability(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((day) => Number.isInteger(day) && STAFF_DAYS.includes(day))
    && new Set(value).size === value.length;
}

function validateStaffInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A staff member is required.';
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) {
    return 'Name must be between 1 and 80 characters.';
  }
  if (body.role !== undefined && (typeof body.role !== 'string' || body.role.trim().length > 60)) {
    return 'Role must be 60 characters or fewer.';
  }
  if (body.availability !== undefined && !isAvailability(body.availability)) {
    return 'Choose one or more valid, unique availability days (0=Sun, 1=Mon, ..., 6=Sat).';
  }
  if (body.maxWeeklyHours !== undefined) {
    const hours = Number(body.maxWeeklyHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 80) {
      return 'Max weekly hours must be between 1 and 80.';
    }
  }
  if (body.inconvenientPreference !== undefined && !['willing', 'neutral', 'prefer_not'].includes(body.inconvenientPreference)) {
    return 'Inconvenient preference must be willing, neutral, or prefer_not.';
  }
  return null;
}

function validationError(res, message, status = 400, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

// ---------------- API ROUTES ----------------

// GET /api/staff
app.get('/api/staff', async (req, res, next) => {
  try {
    if (storageMode === 'file') {
      return res.json([...localData.staff].sort((a, b) => a.name.localeCompare(b.name)).map(localStaffResponse));
    }
    const staff = await Staff.find().sort({ name: 1 });
    res.json(staff);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff
app.post('/api/staff', async (req, res, next) => {
  const inputError = validateStaffInput(req.body);
  if (inputError) return validationError(res, inputError);
  try {
    const staffData = {
      name: req.body.name.trim(),
      role: typeof req.body.role === 'string' && req.body.role.trim() ? req.body.role.trim() : 'Team member',
      availability: req.body.availability ?? [1, 2, 3, 4, 5],
      maxWeeklyHours: req.body.maxWeeklyHours ? Number(req.body.maxWeeklyHours) : 40,
      color: req.body.color || '#7b66e8',
      inconvenientPreference: req.body.inconvenientPreference || 'neutral',
      notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : '',
    };

    if (storageMode === 'file') {
      const person = {
        _id: new mongoose.Types.ObjectId().toString(),
        ...staffData,
      };
      localData.staff.push(person);
      await saveLocalStore();
      return res.status(201).json(localStaffResponse(person));
    }

    const staff = await Staff.create(staffData);
    res.status(201).json(staff);
  } catch (error) {
    next(error);
  }
});

// PUT /api/staff/:id
app.put('/api/staff/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return validationError(res, 'Invalid staff member ID.');
  const inputError = validateStaffInput(req.body);
  if (inputError) return validationError(res, inputError);

  try {
    const updateData = {
      name: req.body.name.trim(),
      role: typeof req.body.role === 'string' && req.body.role.trim() ? req.body.role.trim() : 'Team member',
      availability: req.body.availability ?? [1, 2, 3, 4, 5],
      maxWeeklyHours: req.body.maxWeeklyHours !== undefined ? Number(req.body.maxWeeklyHours) : 40,
      color: req.body.color || '#7b66e8',
      inconvenientPreference: req.body.inconvenientPreference || 'neutral',
      notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : '',
    };

    if (storageMode === 'file') {
      const person = localData.staff.find((entry) => entry._id.toString() === req.params.id);
      if (!person) return res.status(404).json({ error: 'Staff member not found.' });
      Object.assign(person, updateData);
      await saveLocalStore();
      return res.json(localStaffResponse(person));
    }

    const staff = await Staff.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });
    res.json(staff);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/staff/:id
app.delete('/api/staff/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return validationError(res, 'Invalid staff member ID.');
  try {
    if (storageMode === 'file') {
      const staffIndex = localData.staff.findIndex((entry) => entry._id.toString() === req.params.id);
      if (staffIndex === -1) return res.status(404).json({ error: 'Staff member not found.' });
      localData.staff.splice(staffIndex, 1);
      // Remove all shifts assigned to this staff member
      localData.shifts = localData.shifts.filter((shift) => shift.staffId.toString() !== req.params.id);
      await saveLocalStore();
      return res.json({ message: 'Staff member and associated shifts removed.' });
    }

    const staff = await Staff.findByIdAndDelete(req.params.id);
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });
    await Shift.deleteMany({ staffId: req.params.id });
    res.json({ message: 'Staff member and associated shifts removed.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/shifts (supports optional ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&staffId=...)
app.get('/api/shifts', async (req, res, next) => {
  const { startDate, endDate, staffId } = req.query;
  try {
    if (storageMode === 'file') {
      let filtered = [...localData.shifts];
      if (startDate) filtered = filtered.filter((s) => s.date >= startDate);
      if (endDate) filtered = filtered.filter((s) => s.date <= endDate);
      if (staffId) filtered = filtered.filter((s) => s.staffId.toString() === staffId);

      filtered.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
      return res.json(filtered.map((shift) => localShiftResponse(shift, true)));
    }

    const query = {};
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }
    if (staffId && mongoose.isValidObjectId(staffId)) {
      query.staffId = staffId;
    }

    const shifts = await Shift.find(query)
      .populate('staffId', 'name role availability maxWeeklyHours color inconvenientPreference')
      .sort({ date: 1, startTime: 1 });

    // Augment shifts with evaluated inconvenience
    const response = shifts.map((s) => {
      const obj = s.toObject();
      const evalRes = evaluateShiftInconvenience(
        obj.date,
        obj.startTime,
        obj.endTime,
        obj.shiftType,
        obj.isInconvenient,
        obj.inconvenientReason
      );
      return {
        ...obj,
        shiftType: obj.shiftType || evalRes.shiftType,
        isInconvenient: obj.isInconvenient !== undefined ? obj.isInconvenient : evalRes.isInconvenient,
        inconvenientReason: obj.inconvenientReason || evalRes.inconvenientReason,
      };
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// POST /api/shifts (Validates dates, times, availability, overlapping shifts)
app.post('/api/shifts', async (req, res, next) => {
  const { staffId, date, startTime, endTime, shiftType, isInconvenient, inconvenientReason, notes } = req.body ?? {};

  if (!mongoose.isValidObjectId(staffId)) return validationError(res, 'Choose a valid team member.');
  if (typeof date !== 'string' || !isValidDate(date)) return validationError(res, 'Enter a valid shift date (YYYY-MM-DD).');

  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof startTime !== 'string' || !timePattern.test(startTime) || typeof endTime !== 'string' || !timePattern.test(endTime)) {
    return validationError(res, 'Enter valid 24-hour start and end times (HH:MM).');
  }
  if (startTime >= endTime) {
    return validationError(res, 'The end time must be later than the start time.');
  }

  // Calculate inconvenience
  const evalRes = evaluateShiftInconvenience(date, startTime, endTime, shiftType, isInconvenient, inconvenientReason);

  try {
    if (storageMode === 'file') {
      const person = localData.staff.find((entry) => entry._id.toString() === staffId);
      if (!person) return res.status(404).json({ error: 'Staff member not found.' });

      // Availability check
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (!person.availability.includes(weekday)) {
        return validationError(res, `${person.name} is not available on ${DAY_NAMES[weekday]}s.`);
      }

      // Overlap check
      const conflictingShift = localData.shifts.find(
        (shift) =>
          shift.staffId.toString() === staffId &&
          shift.date === date &&
          shift.startTime < endTime &&
          shift.endTime > startTime
      );
      if (conflictingShift) {
        return validationError(
          res,
          `Overlapping shift detected: ${person.name} is already working from ${conflictingShift.startTime} to ${conflictingShift.endTime} on ${date}.`,
          409,
          { conflictingShift: localShiftResponse(conflictingShift) }
        );
      }

      const shift = {
        _id: new mongoose.Types.ObjectId().toString(),
        staffId,
        date,
        startTime,
        endTime,
        shiftType: evalRes.shiftType,
        isInconvenient: evalRes.isInconvenient,
        inconvenientReason: evalRes.inconvenientReason,
        notes: typeof notes === 'string' ? notes.trim() : '',
      };
      localData.shifts.push(shift);
      await saveLocalStore();
      return res.status(201).json(localShiftResponse(shift, true));
    }

    // MongoDB storage
    const person = await Staff.findById(staffId);
    if (!person) return res.status(404).json({ error: 'Staff member not found.' });

    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (!person.availability.includes(weekday)) {
      return validationError(res, `${person.name} is not available on ${DAY_NAMES[weekday]}s.`);
    }

    const conflictingShift = await Shift.findOne({
      staffId,
      date,
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });
    if (conflictingShift) {
      return validationError(
        res,
        `Overlapping shift detected: ${person.name} is already scheduled from ${conflictingShift.startTime} to ${conflictingShift.endTime} on ${date}.`,
        409,
        { conflictingShift }
      );
    }

    const shift = await Shift.create({
      staffId,
      date,
      startTime,
      endTime,
      shiftType: evalRes.shiftType,
      isInconvenient: evalRes.isInconvenient,
      inconvenientReason: evalRes.inconvenientReason,
      notes: typeof notes === 'string' ? notes.trim() : '',
    });

    const populated = await shift.populate('staffId', 'name role availability maxWeeklyHours color inconvenientPreference');
    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
});

// PUT /api/shifts/:id
app.put('/api/shifts/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return validationError(res, 'Invalid shift ID.');
  const { staffId, date, startTime, endTime, shiftType, isInconvenient, inconvenientReason, notes } = req.body ?? {};

  if (!mongoose.isValidObjectId(staffId)) return validationError(res, 'Choose a valid team member.');
  if (typeof date !== 'string' || !isValidDate(date)) return validationError(res, 'Enter a valid shift date (YYYY-MM-DD).');

  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof startTime !== 'string' || !timePattern.test(startTime) || typeof endTime !== 'string' || !timePattern.test(endTime)) {
    return validationError(res, 'Enter valid 24-hour start and end times (HH:MM).');
  }
  if (startTime >= endTime) {
    return validationError(res, 'The end time must be later than the start time.');
  }

  const evalRes = evaluateShiftInconvenience(date, startTime, endTime, shiftType, isInconvenient, inconvenientReason);

  try {
    if (storageMode === 'file') {
      const shiftIndex = localData.shifts.findIndex((s) => s._id.toString() === req.params.id);
      if (shiftIndex === -1) return res.status(404).json({ error: 'Shift not found.' });

      const person = localData.staff.find((entry) => entry._id.toString() === staffId);
      if (!person) return res.status(404).json({ error: 'Staff member not found.' });

      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (!person.availability.includes(weekday)) {
        return validationError(res, `${person.name} is not available on ${DAY_NAMES[weekday]}s.`);
      }

      // Check overlap excluding this shift
      const conflictingShift = localData.shifts.find(
        (shift) =>
          shift._id.toString() !== req.params.id &&
          shift.staffId.toString() === staffId &&
          shift.date === date &&
          shift.startTime < endTime &&
          shift.endTime > startTime
      );
      if (conflictingShift) {
        return validationError(
          res,
          `Overlapping shift detected: ${person.name} already has a shift from ${conflictingShift.startTime} to ${conflictingShift.endTime} on ${date}.`,
          409,
          { conflictingShift: localShiftResponse(conflictingShift) }
        );
      }

      const updated = {
        ...localData.shifts[shiftIndex],
        staffId,
        date,
        startTime,
        endTime,
        shiftType: evalRes.shiftType,
        isInconvenient: evalRes.isInconvenient,
        inconvenientReason: evalRes.inconvenientReason,
        notes: typeof notes === 'string' ? notes.trim() : '',
      };
      localData.shifts[shiftIndex] = updated;
      await saveLocalStore();
      return res.json(localShiftResponse(updated, true));
    }

    const person = await Staff.findById(staffId);
    if (!person) return res.status(404).json({ error: 'Staff member not found.' });

    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (!person.availability.includes(weekday)) {
      return validationError(res, `${person.name} is not available on ${DAY_NAMES[weekday]}s.`);
    }

    const conflictingShift = await Shift.findOne({
      _id: { $ne: req.params.id },
      staffId,
      date,
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });
    if (conflictingShift) {
      return validationError(
        res,
        `Overlapping shift detected: ${person.name} is already working from ${conflictingShift.startTime} to ${conflictingShift.endTime} on ${date}.`,
        409,
        { conflictingShift }
      );
    }

    const shift = await Shift.findByIdAndUpdate(
      req.params.id,
      {
        staffId,
        date,
        startTime,
        endTime,
        shiftType: evalRes.shiftType,
        isInconvenient: evalRes.isInconvenient,
        inconvenientReason: evalRes.inconvenientReason,
        notes: typeof notes === 'string' ? notes.trim() : '',
      },
      { new: true, runValidators: true }
    ).populate('staffId', 'name role availability maxWeeklyHours color inconvenientPreference');

    if (!shift) return res.status(404).json({ error: 'Shift not found.' });
    res.json(shift);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/shifts/:id
app.delete('/api/shifts/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return validationError(res, 'Invalid shift ID.');
  try {
    if (storageMode === 'file') {
      const shiftIndex = localData.shifts.findIndex((entry) => entry._id.toString() === req.params.id);
      if (shiftIndex === -1) return res.status(404).json({ error: 'Shift not found.' });
      localData.shifts.splice(shiftIndex, 1);
      await saveLocalStore();
      return res.json({ message: 'Shift deleted.' });
    }
    const shift = await Shift.findByIdAndDelete(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found.' });
    res.json({ message: 'Shift deleted.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/summary - Detailed fairness, inconvenient shift distribution, and coverage
app.get('/api/summary', async (req, res, next) => {
  const { weekStart, weekEnd } = req.query;
  try {
    let staffList = [];
    let shiftsList = [];

    if (storageMode === 'file') {
      staffList = localData.staff.map(localStaffResponse);
      shiftsList = localData.shifts.map((s) => localShiftResponse(s, false));
    } else {
      const [staffDocs, shiftDocs] = await Promise.all([
        Staff.find().sort({ name: 1 }),
        Shift.find().sort({ date: 1, startTime: 1 }),
      ]);
      staffList = staffDocs.map((d) => d.toObject());
      shiftsList = shiftDocs.map((d) => d.toObject());
    }

    // Filter shifts by date range if provided
    let targetShifts = shiftsList;
    if (weekStart && weekEnd) {
      targetShifts = targetShifts.filter((s) => s.date >= weekStart && s.date <= weekEnd);
    }

    // Per-staff metrics calculation
    const staffSummaryMap = new Map();
    for (const person of staffList) {
      const pid = person._id.toString();
      staffSummaryMap.set(pid, {
        staffId: pid,
        name: person.name,
        role: person.role,
        color: person.color || '#7b66e8',
        maxWeeklyHours: person.maxWeeklyHours || 40,
        availabilityCount: Array.isArray(person.availability) ? person.availability.length : 0,
        inconvenientPreference: person.inconvenientPreference || 'neutral',
        totalShifts: 0,
        totalHours: 0,
        inconvenientShifts: 0,
        weekendShifts: 0,
        closingShifts: 0,
        earlyShifts: 0,
        fairnessScore: 100,
        flags: [],
      });
    }

    let totalTeamHours = 0;
    let totalInconvenientCount = 0;

    for (const shift of targetShifts) {
      const staffIdStr = shift.staffId ? shift.staffId.toString() : '';
      const summary = staffSummaryMap.get(staffIdStr);
      if (!summary) continue;

      const hours = calculateShiftHours(shift.startTime, shift.endTime);
      summary.totalShifts += 1;
      summary.totalHours = Math.round((summary.totalHours + hours) * 100) / 100;
      totalTeamHours += hours;

      const evalRes = evaluateShiftInconvenience(
        shift.date,
        shift.startTime,
        shift.endTime,
        shift.shiftType,
        shift.isInconvenient,
        shift.inconvenientReason
      );

      const weekday = new Date(`${shift.date}T00:00:00.000Z`).getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;
      const isClosing = shift.endTime >= '20:00' || shift.startTime >= '19:00';
      const isEarly = shift.startTime <= '07:30';

      if (evalRes.isInconvenient) {
        summary.inconvenientShifts += 1;
        totalInconvenientCount += 1;
      }
      if (isWeekend) summary.weekendShifts += 1;
      if (isClosing) summary.closingShifts += 1;
      if (isEarly) summary.earlyShifts += 1;
    }

    const staffSummaries = Array.from(staffSummaryMap.values());
    const staffCount = staffSummaries.length;
    const avgHours = staffCount > 0 ? totalTeamHours / staffCount : 0;
    const avgInconvenient = staffCount > 0 ? totalInconvenientCount / staffCount : 0;

    // Calculate fairness scores and flags
    for (const summary of staffSummaries) {
      if (summary.totalHours > summary.maxWeeklyHours) {
        summary.flags.push(`Exceeds max weekly limit (${summary.totalHours}h / ${summary.maxWeeklyHours}h)`);
      }
      if (avgInconvenient > 0 && summary.inconvenientShifts >= avgInconvenient * 2 && summary.inconvenientShifts > 1) {
        summary.flags.push(`High inconvenient shift load (${summary.inconvenientShifts} shifts vs ~${Math.round(avgInconvenient * 10) / 10} avg)`);
      }
      if (summary.inconvenientPreference === 'prefer_not' && summary.inconvenientShifts > 0) {
        summary.flags.push(`Assigned ${summary.inconvenientShifts} inconvenient shifts despite preferring not to`);
      }

      // Fairness deviation score (higher is fairer)
      if (avgInconvenient > 0) {
        const diff = Math.abs(summary.inconvenientShifts - avgInconvenient);
        summary.fairnessScore = Math.max(20, Math.round(100 - diff * 20));
      } else {
        summary.fairnessScore = 100;
      }
    }

    // Calculate team fairness index (Gini / deviation index)
    let teamFairnessIndex = 100;
    if (staffCount > 1 && totalInconvenientCount > 0) {
      const maxInconvenient = Math.max(...staffSummaries.map((s) => s.inconvenientShifts));
      const minInconvenient = Math.min(...staffSummaries.map((s) => s.inconvenientShifts));
      const spread = maxInconvenient - minInconvenient;
      teamFairnessIndex = Math.max(30, Math.round(100 - (spread / Math.max(1, totalInconvenientCount)) * 80));
    }

    let balanceGrade = 'Excellent';
    if (teamFairnessIndex < 60) balanceGrade = 'Needs Attention';
    else if (teamFairnessIndex < 80) balanceGrade = 'Moderate Balance';

    // Generate actionable recommendations
    const recommendations = [];
    if (staffCount >= 2 && totalInconvenientCount >= 2) {
      const overloaded = staffSummaries
        .filter((s) => s.inconvenientShifts > avgInconvenient + 1)
        .sort((a, b) => b.inconvenientShifts - a.inconvenientShifts);
      const underloaded = staffSummaries
        .filter((s) => s.inconvenientShifts < avgInconvenient && s.availabilityCount >= 3)
        .sort((a, b) => a.inconvenientShifts - b.inconvenientShifts);

      if (overloaded.length > 0 && underloaded.length > 0) {
        recommendations.push(
          `${overloaded[0].name} has ${overloaded[0].inconvenientShifts} inconvenient shifts. Consider shifting upcoming closing/weekend duties to ${underloaded[0].name} (${underloaded[0].inconvenientShifts} assigned).`
        );
      }
    }

    res.json({
      staffSummaries,
      teamMetrics: {
        totalStaff: staffCount,
        totalShifts: targetShifts.length,
        totalHours: Math.round(totalTeamHours * 10) / 10,
        totalInconvenientShifts: totalInconvenientCount,
        avgHoursPerPerson: Math.round(avgHours * 10) / 10,
        avgInconvenientPerPerson: Math.round(avgInconvenient * 10) / 10,
        teamFairnessIndex,
        balanceGrade,
      },
      recommendations,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/shifts/suggest-staff - Smart fairness recommendation for assigning a shift
app.post('/api/shifts/suggest-staff', async (req, res, next) => {
  const { date, startTime, endTime, shiftType, isInconvenient } = req.body ?? {};
  if (!date || !startTime || !endTime) {
    return validationError(res, 'Date, startTime, and endTime are required to suggest staff.');
  }

  try {
    let staffList = [];
    let shiftsList = [];

    if (storageMode === 'file') {
      staffList = localData.staff.map(localStaffResponse);
      shiftsList = localData.shifts;
    } else {
      const [staffDocs, shiftDocs] = await Promise.all([
        Staff.find().sort({ name: 1 }),
        Shift.find().sort({ date: 1 }),
      ]);
      staffList = staffDocs.map((d) => d.toObject());
      shiftsList = shiftDocs.map((d) => d.toObject());
    }

    const shiftWeekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const isShiftInconvenient = evaluateShiftInconvenience(date, startTime, endTime, shiftType, isInconvenient).isInconvenient;
    const shiftHours = calculateShiftHours(startTime, endTime);

    // Compute current week's shift load per staff member
    // Find monday of date
    const targetDate = new Date(`${date}T00:00:00.000Z`);
    const monday = new Date(targetDate);
    monday.setUTCDate(targetDate.getUTCDate() - ((targetDate.getUTCDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);

    const weekStartStr = monday.toISOString().slice(0, 10);
    const weekEndStr = sunday.toISOString().slice(0, 10);

    const suggestions = staffList.map((person) => {
      const pid = person._id.toString();
      const isAvailableOnDay = person.availability.includes(shiftWeekday);

      // Check conflict
      const conflictingShift = shiftsList.find(
        (s) =>
          s.staffId.toString() === pid &&
          s.date === date &&
          s.startTime < endTime &&
          s.endTime > startTime
      );

      // Weekly stats for this person
      const weekShifts = shiftsList.filter(
        (s) => s.staffId.toString() === pid && s.date >= weekStartStr && s.date <= weekEndStr
      );

      const weekHours = weekShifts.reduce((acc, s) => acc + calculateShiftHours(s.startTime, s.endTime), 0);
      const weekInconvenient = weekShifts.filter(
        (s) => evaluateShiftInconvenience(s.date, s.startTime, s.endTime, s.shiftType, s.isInconvenient).isInconvenient
      ).length;

      let score = 100;
      let status = 'recommended';
      const reasons = [];

      if (!isAvailableOnDay) {
        score -= 200;
        status = 'unavailable';
        reasons.push(`Not available on ${DAY_NAMES[shiftWeekday]}s`);
      }

      if (conflictingShift) {
        score -= 500;
        status = 'conflict';
        reasons.push(`Overlaps with existing shift (${conflictingShift.startTime}–${conflictingShift.endTime})`);
      }

      if (isAvailableOnDay && !conflictingShift) {
        // Fairness penalty for already working inconvenient shifts
        if (isShiftInconvenient) {
          score -= weekInconvenient * 25;
          if (weekInconvenient > 0) {
            reasons.push(`Already has ${weekInconvenient} inconvenient shift(s) this week`);
          } else {
            reasons.push('0 inconvenient shifts this week (Fairness Priority)');
          }
        }

        // Penalty for high hours
        score -= Math.round((weekHours / (person.maxWeeklyHours || 40)) * 30);

        if (weekHours + shiftHours > (person.maxWeeklyHours || 40)) {
          score -= 40;
          reasons.push(`Would exceed max weekly limit (${person.maxWeeklyHours || 40}h)`);
          status = 'caution';
        }

        if (person.inconvenientPreference === 'prefer_not' && isShiftInconvenient) {
          score -= 30;
          reasons.push('Prefers not to work inconvenient shifts');
          if (status !== 'caution') status = 'caution';
        } else if (person.inconvenientPreference === 'willing' && isShiftInconvenient) {
          score += 15;
          reasons.push('Willing to work inconvenient shifts');
        }

        if (score >= 80 && status !== 'caution') {
          status = 'recommended';
        } else if (status !== 'caution') {
          status = 'eligible';
        }
      }

      return {
        staffId: pid,
        name: person.name,
        role: person.role,
        color: person.color || '#7b66e8',
        score,
        status,
        reasons,
        currentWeekHours: Math.round(weekHours * 10) / 10,
        currentWeekInconvenient: weekInconvenient,
        maxWeeklyHours: person.maxWeeklyHours || 40,
        isAvailable: isAvailableOnDay,
        hasConflict: Boolean(conflictingShift),
      };
    });

    suggestions.sort((a, b) => b.score - a.score);
    res.json({
      isShiftInconvenient,
      suggestions,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/coverage - Analyzes operating hours coverage for a week
app.get('/api/coverage', async (req, res, next) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return validationError(res, 'startDate and endDate are required.');
  }

  try {
    let shiftsList = [];
    let operatingHours = DEFAULT_OPERATING_HOURS;

    if (storageMode === 'file') {
      shiftsList = localData.shifts.filter((s) => s.date >= startDate && s.date <= endDate);
      operatingHours = localData.operatingHours || DEFAULT_OPERATING_HOURS;
    } else {
      shiftsList = await Shift.find({ date: { $gte: startDate, $lte: endDate } }).populate('staffId', 'name role');
      const settings = await Settings.findOne();
      if (settings && settings.operatingHours) {
        operatingHours = { ...DEFAULT_OPERATING_HOURS, ...settings.operatingHours.toObject() };
      }
    }

    const opStartMins = parseTimeToMinutes(operatingHours.start || '08:00');
    const opEndMins = parseTimeToMinutes(operatingHours.end || '21:00');
    const totalDailyOpHours = (opEndMins - opStartMins) / 60;

    // Generate date range
    const days = [];
    const curr = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);

    while (curr <= end) {
      const dateStr = curr.toISOString().slice(0, 10);
      const weekday = curr.getUTCDay();
      const dayShifts = shiftsList.filter((s) => s.date === dateStr);

      // Hourly coverage tracking from opStartMins to opEndMins (in 60-min slots)
      const hourlySlots = [];
      let coveredSlots = 0;
      const totalSlots = Math.floor((opEndMins - opStartMins) / 60);

      for (let m = opStartMins; m < opEndMins; m += 60) {
        const slotEnd = m + 60;
        const activeShifts = dayShifts.filter((s) => {
          const sStart = parseTimeToMinutes(s.startTime);
          const sEnd = parseTimeToMinutes(s.endTime);
          return sStart < slotEnd && sEnd > m;
        });

        const isCovered = activeShifts.length > 0;
        if (isCovered) coveredSlots += 1;

        const slotTimeStr = `${String(Math.floor(m / 60)).padStart(2, '0')}:00`;
        hourlySlots.push({
          time: slotTimeStr,
          covered: isCovered,
          staffCount: activeShifts.length,
          staffNames: activeShifts.map((s) => (s.staffId && s.staffId.name ? s.staffId.name : 'Assigned')),
        });
      }

      const coveragePercent = totalSlots > 0 ? Math.round((coveredSlots / totalSlots) * 100) : 100;

      days.push({
        date: dateStr,
        dayName: DAY_NAMES[weekday],
        coveragePercent,
        coveredHours: coveredSlots,
        totalHours: totalSlots,
        hourlySlots,
        shiftsCount: dayShifts.length,
      });

      curr.setUTCDate(curr.getUTCDate() + 1);
    }

    const overallCovered = days.reduce((acc, d) => acc + d.coveredHours, 0);
    const overallTotal = days.reduce((acc, d) => acc + d.totalHours, 0);
    const overallPercent = overallTotal > 0 ? Math.round((overallCovered / overallTotal) * 100) : 100;

    res.json({
      operatingHours,
      overallPercent,
      days,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/operating-hours
app.get('/api/operating-hours', async (req, res, next) => {
  try {
    if (storageMode === 'file') {
      return res.json(localData.operatingHours || DEFAULT_OPERATING_HOURS);
    }
    const settings = await Settings.findOne();
    if (!settings) {
      return res.json(DEFAULT_OPERATING_HOURS);
    }
    res.json(settings.operatingHours);
  } catch (error) {
    next(error);
  }
});

// PUT /api/operating-hours
app.put('/api/operating-hours', async (req, res, next) => {
  const { start, end } = req.body ?? {};
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(start) || !timePattern.test(end) || start >= end) {
    return validationError(res, 'Valid operating hours start and end times are required (start < end).');
  }

  try {
    if (storageMode === 'file') {
      localData.operatingHours = { ...DEFAULT_OPERATING_HOURS, start, end };
      await saveLocalStore();
      return res.json(localData.operatingHours);
    }
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({ operatingHours: { start, end } });
    } else {
      settings.operatingHours = { start, end };
      await settings.save();
    }
    res.json(settings.operatingHours);
  } catch (error) {
    next(error);
  }
});

// POST /api/seed - Seed realistic sample team and shifts to demonstrate fairness & overlap detection
app.post('/api/seed', async (req, res, next) => {
  try {
    const sampleStaff = [
      {
        name: 'Alex Rivera',
        role: 'Team Lead',
        availability: [1, 2, 3, 4, 5],
        maxWeeklyHours: 40,
        color: '#7b66e8',
        inconvenientPreference: 'willing',
      },
      {
        name: 'Samira Chen',
        role: 'Barista / Front',
        availability: [0, 1, 2, 3, 4],
        maxWeeklyHours: 35,
        color: '#e58a53',
        inconvenientPreference: 'neutral',
      },
      {
        name: 'Jordan Miller',
        role: 'Shift Supervisor',
        availability: [2, 3, 4, 5, 6],
        maxWeeklyHours: 38,
        color: '#48a88b',
        inconvenientPreference: 'prefer_not',
      },
      {
        name: 'Morgan Taylor',
        role: 'Service Specialist',
        availability: [0, 4, 5, 6],
        maxWeeklyHours: 30,
        color: '#d26383',
        inconvenientPreference: 'willing',
      },
      {
        name: 'Casey Brooks',
        role: 'Customer Support',
        availability: [1, 2, 3, 5, 6],
        maxWeeklyHours: 32,
        color: '#5791cf',
        inconvenientPreference: 'neutral',
      },
    ];

    // Determine current week's Monday
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));

    function getFormattedDate(offsetDays) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + offsetDays);
      return d.toISOString().slice(0, 10);
    }

    if (storageMode === 'file') {
      const createdStaff = sampleStaff.map((person) => ({
        _id: new mongoose.Types.ObjectId().toString(),
        ...person,
      }));
      localData.staff = createdStaff;

      const p0 = createdStaff[0]._id;
      const p1 = createdStaff[1]._id;
      const p2 = createdStaff[2]._id;
      const p3 = createdStaff[3]._id;
      const p4 = createdStaff[4]._id;

      localData.shifts = [
        // Monday (offset 0)
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p0, date: getFormattedDate(0), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Morning lead' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p1, date: getFormattedDate(0), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Closing barista' },
        // Tuesday (offset 1)
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p0, date: getFormattedDate(1), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Day shift' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p4, date: getFormattedDate(1), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Evening support' },
        // Wednesday (offset 2)
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p2, date: getFormattedDate(2), startTime: '07:00', endTime: '15:00', shiftType: 'opening', isInconvenient: true, notes: 'Early opening' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p1, date: getFormattedDate(2), startTime: '12:00', endTime: '20:00', shiftType: 'closing', isInconvenient: true, notes: 'Mid to close' },
        // Thursday (offset 3)
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p0, date: getFormattedDate(3), startTime: '09:00', endTime: '17:00', shiftType: 'standard', isInconvenient: false, notes: 'Midday supervisor' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p2, date: getFormattedDate(3), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Evening lead' },
        // Friday (offset 4)
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p3, date: getFormattedDate(4), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Floor specialist' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p4, date: getFormattedDate(4), startTime: '13:00', endTime: '21:30', shiftType: 'closing', isInconvenient: true, notes: 'Friday night close' },
        // Saturday (offset 5) - Weekend
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p3, date: getFormattedDate(5), startTime: '09:00', endTime: '17:00', shiftType: 'weekend', isInconvenient: true, notes: 'Saturday day' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p2, date: getFormattedDate(5), startTime: '12:00', endTime: '20:30', shiftType: 'weekend', isInconvenient: true, notes: 'Saturday close' },
        // Sunday (offset 6) - Weekend
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p1, date: getFormattedDate(6), startTime: '10:00', endTime: '18:00', shiftType: 'weekend', isInconvenient: true, notes: 'Sunday front lead' },
        { _id: new mongoose.Types.ObjectId().toString(), staffId: p3, date: getFormattedDate(6), startTime: '12:00', endTime: '20:00', shiftType: 'weekend', isInconvenient: true, notes: 'Sunday closing' },
      ];

      localData.operatingHours = { ...DEFAULT_OPERATING_HOURS };
      await saveLocalStore();
      return res.json({ message: 'Sample team and balanced shifts seeded successfully.' });
    }

    // MongoDB clear and seed
    await Staff.deleteMany({});
    await Shift.deleteMany({});

    const createdStaff = await Staff.insertMany(sampleStaff);
    const p0 = createdStaff[0]._id;
    const p1 = createdStaff[1]._id;
    const p2 = createdStaff[2]._id;
    const p3 = createdStaff[3]._id;
    const p4 = createdStaff[4]._id;

    const sampleShifts = [
      { staffId: p0, date: getFormattedDate(0), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Morning lead' },
      { staffId: p1, date: getFormattedDate(0), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Closing barista' },
      { staffId: p0, date: getFormattedDate(1), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Day shift' },
      { staffId: p4, date: getFormattedDate(1), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Evening support' },
      { staffId: p2, date: getFormattedDate(2), startTime: '07:00', endTime: '15:00', shiftType: 'opening', isInconvenient: true, notes: 'Early opening' },
      { staffId: p1, date: getFormattedDate(2), startTime: '12:00', endTime: '20:00', shiftType: 'closing', isInconvenient: true, notes: 'Mid to close' },
      { staffId: p0, date: getFormattedDate(3), startTime: '09:00', endTime: '17:00', shiftType: 'standard', isInconvenient: false, notes: 'Midday supervisor' },
      { staffId: p2, date: getFormattedDate(3), startTime: '13:00', endTime: '21:00', shiftType: 'closing', isInconvenient: true, notes: 'Evening lead' },
      { staffId: p3, date: getFormattedDate(4), startTime: '08:00', endTime: '16:00', shiftType: 'standard', isInconvenient: false, notes: 'Floor specialist' },
      { staffId: p4, date: getFormattedDate(4), startTime: '13:00', endTime: '21:30', shiftType: 'closing', isInconvenient: true, notes: 'Friday night close' },
      { staffId: p3, date: getFormattedDate(5), startTime: '09:00', endTime: '17:00', shiftType: 'weekend', isInconvenient: true, notes: 'Saturday day' },
      { staffId: p2, date: getFormattedDate(5), startTime: '12:00', endTime: '20:30', shiftType: 'weekend', isInconvenient: true, notes: 'Saturday close' },
      { staffId: p1, date: getFormattedDate(6), startTime: '10:00', endTime: '18:00', shiftType: 'weekend', isInconvenient: true, notes: 'Sunday front lead' },
      { staffId: p3, date: getFormattedDate(6), startTime: '12:00', endTime: '20:00', shiftType: 'weekend', isInconvenient: true, notes: 'Sunday closing' },
    ];

    await Shift.insertMany(sampleShifts);
    res.json({ message: 'Sample team and balanced shifts seeded successfully.' });
  } catch (error) {
    next(error);
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: storageMode,
    timestamp: new Date().toISOString(),
    features: ['fairness_engine', 'overlap_detection', 'operating_hours_coverage', 'smart_suggestions'],
  });
});

// Catch-all 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Centralized error-handling middleware
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ error: error.message });
  }
  console.error('API request failed:', error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 5000;

  async function start() {
    await initStorage();
    app.listen(port, () => console.log(`StaffShift Fairness API listening on port ${port} (${storageMode} storage).`));
  }

  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
