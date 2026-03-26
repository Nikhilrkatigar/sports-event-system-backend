const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { Event, Application, AuditLog, Tournament } = require('../models');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const {
  getRegistrationState,
  getNormalizedEventPayload,
  syncEventRegistrationStatus
} = require('../utils/events');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/events';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

// File filter for image validation
const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1 * 1024 * 1024 // 1MB limit
  }
});

const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'paymentQRCode', maxCount: 1 }
]);

const getEventCounts = async (eventIds) => {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return new Map();
  const rows = await Application.aggregate([
    { $match: { eventId: { $in: eventIds } } },
    {
      $project: {
        eventId: 1,
        mainPlayerCount: {
          $size: {
            $filter: {
              input: '$players',
              as: 'player',
              cond: { $ne: ['$$player.isSubstitute', true] }
            }
          }
        }
      }
    },
    {
      $group: {
        _id: '$eventId',
        teamCount: { $sum: 1 },
        playerCount: { $sum: '$mainPlayerCount' }
      }
    }
  ]);

  return new Map(rows.map((row) => [String(row._id), row]));
};

const decorateEvent = (event, counts) => {
  const registrationState = getRegistrationState(event, counts);
  return {
    ...event,
    teamCount: registrationState.teamCount,
    playerCount: registrationState.playerCount,
    remainingSlots: registrationState.remainingSlots,
    availableTeams: registrationState.availableTeams,
    isFull: registrationState.isFull,
    isPastDeadline: registrationState.isPastDeadline,
    canRegister: registrationState.canRegister
  };
};

// Public: Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1, title: 1 }).lean();
    const eventCounts = await getEventCounts(events.map((event) => event._id));
    const decoratedEvents = events.map((event) => decorateEvent(event, eventCounts.get(String(event._id))));
    
    res.json(decoratedEvents);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export all events as Excel
router.get('/export/excel', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1, title: 1 }).lean();
    const eventCounts = await getEventCounts(events.map((event) => event._id));

    const rows = events.map((event) => {
      const counts = eventCounts.get(String(event._id)) || {};
      const registrationState = getRegistrationState(event, counts);
      
      return {
        'Event Title': event.title,
        'Type': event.type === 'team' ? 'Team' : 'Single Player',
        'Lifecycle Status': event.status,
        'Registration': event.registrationOpen ? 'Open' : 'Closed',
        'Date': event.date ? new Date(event.date).toLocaleDateString() : 'N/A',
        'Time': event.startTime || 'N/A',
        'Teams Registered': registrationState.teamCount || 0,
        'Players Registered': registrationState.playerCount || 0,
        'Max Participants': event.maxParticipants || 'Unlimited',
        'Team Size': event.teamSize || 'N/A',
        'Score Order': event.scoreOrder === 'asc' ? 'Lower wins' : 'Higher wins',
        'Registration Fee': event.registrationFee || 'Free',
        'Venue': event.venue || 'N/A',
        'Status': event.isFull ? 'Full' : registrationState.canRegister ? 'Available' : 'Closed'
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Events');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="All_Events.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Export all events as CSV
router.get('/export/csv', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1, title: 1 }).lean();
    const eventCounts = await getEventCounts(events.map((event) => event._id));

    const rows = events.map((event) => {
      const counts = eventCounts.get(String(event._id)) || {};
      const registrationState = getRegistrationState(event, counts);
      
      return {
        'Event Title': event.title,
        'Type': event.type === 'team' ? 'Team' : 'Single Player',
        'Lifecycle Status': event.status,
        'Registration': event.registrationOpen ? 'Open' : 'Closed',
        'Date': event.date ? new Date(event.date).toLocaleDateString() : 'N/A',
        'Time': event.startTime || 'N/A',
        'Teams Registered': registrationState.teamCount || 0,
        'Players Registered': registrationState.playerCount || 0,
        'Max Participants': event.maxParticipants || 'Unlimited',
        'Team Size': event.teamSize || 'N/A',
        'Score Order': event.scoreOrder === 'asc' ? 'Lower wins' : 'Higher wins',
        'Registration Fee': event.registrationFee || 'Free',
        'Venue': event.venue || 'N/A',
        'Status': event.isFull ? 'Full' : registrationState.canRegister ? 'Available' : 'Closed'
      };
    });

    const csv = [
      ['Event Title', 'Type', 'Lifecycle Status', 'Registration', 'Date', 'Time', 'Teams Registered', 'Players Registered', 'Max Participants', 'Team Size', 'Score Order', 'Registration Fee', 'Venue', 'Status'],
      ...rows.map((row) =>
        [
          row['Event Title'],
          row['Type'],
          row['Lifecycle Status'],
          row['Registration'],
          row['Date'],
          row['Time'],
          row['Teams Registered'],
          row['Players Registered'],
          row['Max Participants'],
          row['Team Size'],
          row['Score Order'],
          row['Registration Fee'],
          row['Venue'],
          row['Status']
        ].map((field) => `"${String(field).replace(/"/g, '""')}"`)
      )
    ]
      .map((row) => row.join(','))
      .join('\n');

    res.setHeader('Content-Disposition', 'attachment; filename="All_Events.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get single event
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const eventCounts = await getEventCounts([event._id]);
    const decoratedEvent = decorateEvent(event, eventCounts.get(String(event._id)));
    
    res.json(decoratedEvent);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Create event
router.post('/', auth, requirePermission('manage_events'), uploadFields, async (req, res) => {
  try {
    const data = getNormalizedEventPayload(req.body);
    if (req.files?.image?.[0]) data.image = `/uploads/events/${req.files.image[0].filename}`;
    if (req.files?.paymentQRCode?.[0]) data.paymentQRCode = `/uploads/events/${req.files.paymentQRCode[0].filename}`;
    if (data.type !== 'team') data.teamSize = 1;
    const event = new Event(data);
    await event.save();
    await syncEventRegistrationStatus(event, { teamCount: 0, playerCount: 0 });
    await AuditLog.create({ action: `Event Created: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.status(201).json(event);
  } catch (err) {
    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'File size exceeds 1MB limit' });
    }
    if (err.message && err.message.includes('allowed')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
});

// Admin: Update event
router.put('/:id', auth, requirePermission('manage_events'), uploadFields, async (req, res) => {
  try {
    const data = getNormalizedEventPayload(req.body);
    if (req.files?.image?.[0]) data.image = `/uploads/events/${req.files.image[0].filename}`;
    if (req.files?.paymentQRCode?.[0]) data.paymentQRCode = `/uploads/events/${req.files.paymentQRCode[0].filename}`;
    if (data.type !== 'team') data.teamSize = 1;
    const event = await Event.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const eventCounts = await getEventCounts([event._id]);
    await syncEventRegistrationStatus(event, eventCounts.get(String(event._id)));
    await AuditLog.create({ action: `Event Updated: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json(event);
  } catch (err) {
    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'File size exceeds 1MB limit' });
    }
    if (err.message && err.message.includes('allowed')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
});

// Admin: Toggle registration open/closed
router.patch('/:id/toggle-registration', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    const eventCounts = await getEventCounts([event._id]);
    const state = getRegistrationState(event, eventCounts.get(String(event._id)));

    if (event.status === 'open' || event.status === 'full') {
      event.registrationOpen = false;
      event.status = 'published';
    } else {
      if (state.isFull) {
        return res.status(400).json({ message: 'This event is already full. Increase capacity before reopening registration.' });
      }
      event.registrationOpen = true;
      event.status = 'open';
    }
    await event.save();
    const status = event.registrationOpen ? 'opened' : 'closed';
    await AuditLog.create({ action: `Registration ${status}: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json(event);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Delete event
router.delete('/:id', auth, requirePermission('manage_events'), async (req, res) => {
  try {
    const registrationsCount = await Application.countDocuments({ eventId: req.params.id });
    if (registrationsCount > 0) {
      return res.status(400).json({ message: 'Cannot delete an event that already has registrations. Archive it instead.' });
    }

    const tournamentExists = await Tournament.exists({ eventId: req.params.id });
    if (tournamentExists) {
      return res.status(400).json({ message: 'Cannot delete an event with an existing tournament. Delete or archive the tournament first.' });
    }

    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    await AuditLog.create({ action: `Event Deleted: ${event.title}`, admin: req.admin.name, ip: req.ip });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Like/Unlike event
router.post('/:id/like', async (req, res) => {
  try {
    const { deviceId, action } = req.body;
    if (!deviceId || !action) return res.status(400).json({ message: 'deviceId and action required' });
    
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    
    if (action === 'like') {
      if (!event.likes.includes(deviceId)) {
        event.likes.push(deviceId);
      }
    } else if (action === 'unlike') {
      const index = event.likes.indexOf(deviceId);
      if (index > -1) {
        event.likes.splice(index, 1);
      }
    }
    
    await event.save();
    res.json({ likes: event.likes.length, liked: event.likes.includes(deviceId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Mark interested (for coming soon events)
router.post('/:id/interested', async (req, res) => {
  try {
    const { deviceId, action } = req.body;
    if (!deviceId || !action) return res.status(400).json({ message: 'deviceId and action required' });
    
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    
    if (action === 'add') {
      if (!event.interested.includes(deviceId)) {
        event.interested.push(deviceId);
      }
    } else if (action === 'remove') {
      const index = event.interested.indexOf(deviceId);
      if (index > -1) {
        event.interested.splice(index, 1);
      }
    }
    
    await event.save();
    res.json({ interested: event.interested.length, isInterested: event.interested.includes(deviceId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Get comments for event
router.get('/:id/comments', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json(event.comments || []);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: Share event (increment share counter)
router.post('/:id/share', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    
    event.shares = (event.shares || 0) + 1;
    await event.save();
    
    res.json({ shares: event.shares });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
