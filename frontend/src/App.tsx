import React, { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

export type Staff = {
  _id: string
  name: string
  role: string
  availability: number[] // 0 (Sun) to 6 (Sat)
  maxWeeklyHours?: number
  color?: string
  inconvenientPreference?: 'willing' | 'neutral' | 'prefer_not'
  notes?: string
}

export type Shift = {
  _id: string
  staffId: Staff | string
  date: string
  startTime: string
  endTime: string
  shiftType?: 'standard' | 'opening' | 'closing' | 'night' | 'weekend' | 'custom_inconvenient'
  isInconvenient?: boolean
  inconvenientReason?: string
  notes?: string
}

export type StaffSummary = {
  staffId: string
  name: string
  role: string
  color: string
  maxWeeklyHours: number
  availabilityCount: number
  inconvenientPreference: 'willing' | 'neutral' | 'prefer_not'
  totalShifts: number
  totalHours: number
  inconvenientShifts: number
  weekendShifts: number
  closingShifts: number
  earlyShifts: number
  fairnessScore: number
  flags: string[]
}

export type TeamMetrics = {
  totalStaff: number
  totalShifts: number
  totalHours: number
  totalInconvenientShifts: number
  avgHoursPerPerson: number
  avgInconvenientPerPerson: number
  teamFairnessIndex: number
  balanceGrade: 'Excellent' | 'Good' | 'Moderate Balance' | 'Needs Attention' | 'Unbalanced'
}

export type SummaryResponse = {
  staffSummaries: StaffSummary[]
  teamMetrics: TeamMetrics
  recommendations: string[]
}

export type CoverageSlot = {
  time: string
  covered: boolean
  staffCount: number
  staffNames: string[]
}

export type CoverageDay = {
  date: string
  dayName: string
  coveragePercent: number
  coveredHours: number
  totalHours: number
  hourlySlots: CoverageSlot[]
  shiftsCount: number
}

export type CoverageResponse = {
  operatingHours: { start: string; end: string }
  overallPercent: number
  days: CoverageDay[]
}

export type StaffSuggestion = {
  staffId: string
  name: string
  role: string
  color: string
  score: number
  status: 'recommended' | 'eligible' | 'caution' | 'unavailable' | 'conflict'
  reasons: string[]
  currentWeekHours: number
  currentWeekInconvenient: number
  maxWeeklyHours: number
  isAvailable: boolean
  hasConflict: boolean
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const COLORS = ['#7b66e8', '#e58a53', '#48a88b', '#d26383', '#5791cf', '#c19a49', '#9b59b6', '#3498db']

function localDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function mondayOf(date: Date) {
  const monday = new Date(date)
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  return monday
}

function staffForShift(shift: Shift, staff: Staff[]): Staff | undefined {
  if (typeof shift.staffId !== 'string') return shift.staffId
  return staff.find((person) => person._id === shift.staffId)
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function calculateHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  return Math.max(0, Math.round(((eh * 60 + em - (sh * 60 + sm)) / 60) * 10) / 10)
}

function isShiftInconvenient(date: string, startTime: string, endTime: string, explicitFlag?: boolean): boolean {
  if (explicitFlag) return true
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  if (weekday === 0 || weekday === 6) return true
  if (startTime <= '07:30') return true
  if (endTime >= '20:00' || startTime >= '19:00') return true
  return false
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  const paths: Record<string, React.ReactNode> = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    people: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    chart: <><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-5 5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    chevronLeft: <path d="m15 18-6-6 6-6" />,
    chevronRight: <path d="m9 18 6-6-6-6" />,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    alert: <><path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6" /><path d="M10 11v5m4-5v5" /></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1 2.5 2.5 1-2.5 1L19 21l-1-2.5-2.5-1 2.5-1 1-2.5Z" /></>,
    moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
    check: <polyline points="20 6 9 17 4 12" />,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></>,
  }
  return <svg {...common}>{paths[name] ?? paths.calendar}</svg>
}

export default function App() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [summaryData, setSummaryData] = useState<SummaryResponse | null>(null)
  const [coverageData, setCoverageData] = useState<CoverageResponse | null>(null)
  const [operatingHours, setOperatingHours] = useState({ start: '08:00', end: '21:00' })
  const [week, setWeek] = useState(() => mondayOf(new Date()))
  const [today] = useState(() => localDate(new Date()))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [apiConnected, setApiConnected] = useState(false)
  const [storageType, setStorageType] = useState<'mongodb' | 'file' | 'connecting'>('connecting')
  const [activeTab, setActiveTab] = useState<'schedule' | 'fairness' | 'coverage' | 'team'>('schedule')
  const [modal, setModal] = useState<'shift' | 'staff' | 'availability' | 'operatingHours' | null>(null)
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)
  const [filterStaffId, setFilterStaffId] = useState<string>('all')
  const [filterInconvenientOnly, setFilterInconvenientOnly] = useState<boolean>(false)

  // Smart suggestions inside the shift creation modal
  const [suggestions, setSuggestions] = useState<StaffSuggestion[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [shiftFormDate, setShiftFormDate] = useState(() => localDate(new Date()))
  const [shiftFormStart, setShiftFormStart] = useState('09:00')
  const [shiftFormEnd, setShiftFormEnd] = useState('17:00')
  const [shiftFormExplicitInconvenient, setShiftFormExplicitInconvenient] = useState(false)
  const [shiftFormSelectedStaff, setShiftFormSelectedStaff] = useState('')

  const request = useCallback(async (path: string, options?: RequestInit) => {
    let response: Response
    try {
      response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
          ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
          ...options?.headers,
        },
      })
    } catch {
      setApiConnected(false)
      setStorageType('connecting')
      throw new Error('Can’t reach the StaffShift API. Check that the backend is running on port 5000.')
    }

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(typeof data.error === 'string' ? data.error : 'The request could not be completed.')
      // Attach extra payload if available (e.g. conflicting shift)
      ;(err as any).details = data
      throw err
    }
    return data
  }, [])

  const weekDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(week)
      date.setDate(week.getDate() + index)
      return date
    })
  }, [week])

  const weekStartStr = useMemo(() => localDate(weekDates[0]), [weekDates])
  const weekEndStr = useMemo(() => localDate(weekDates[6]), [weekDates])
  const weekLabel = `${weekDates[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekDates[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const [nextStaff, nextShifts, nextSummary, nextCoverage, health] = await Promise.all([
        request('/staff'),
        request(`/shifts?startDate=${weekStartStr}&endDate=${weekEndStr}`),
        request(`/summary?weekStart=${weekStartStr}&weekEnd=${weekEndStr}`),
        request(`/coverage?startDate=${weekStartStr}&endDate=${weekEndStr}`),
        request('/health').catch(() => ({ status: 'ok', storage: 'file' })),
      ])

      setStaff(nextStaff)
      setShifts(nextShifts)
      setSummaryData(nextSummary)
      setCoverageData(nextCoverage)
      if (nextCoverage?.operatingHours) {
        setOperatingHours(nextCoverage.operatingHours)
      }
      setApiConnected(true)
      setStorageType(health.storage || 'file')
      return true
    } catch (error) {
      setApiConnected(false)
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to load planner data.' })
      return false
    }
  }, [request, weekStartStr, weekEndStr])

  useEffect(() => {
    let active = true
    Promise.all([
      request('/staff'),
      request(`/shifts?startDate=${weekStartStr}&endDate=${weekEndStr}`),
      request(`/summary?weekStart=${weekStartStr}&weekEnd=${weekEndStr}`),
      request(`/coverage?startDate=${weekStartStr}&endDate=${weekEndStr}`),
      request('/health').catch(() => ({ status: 'ok', storage: 'file' })),
    ])
      .then(([nextStaff, nextShifts, nextSummary, nextCoverage, health]) => {
        if (!active) return
        setStaff(nextStaff)
        setShifts(nextShifts)
        setSummaryData(nextSummary)
        setCoverageData(nextCoverage)
        if (nextCoverage?.operatingHours) {
          setOperatingHours(nextCoverage.operatingHours)
        }
        setApiConnected(true)
        setStorageType(health.storage || 'file')
      })
      .catch((error: unknown) => {
        if (!active) return
        setApiConnected(false)
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to connect to the backend API.' })
      })
    return () => { active = false }
  }, [request, weekStartStr, weekEndStr])

  // Overlap Detection Engine across current week shifts
  const overlappingShiftMap = useMemo(() => {
    const conflictMap = new Map<string, Shift[]>()
    for (let i = 0; i < shifts.length; i++) {
      const s1 = shifts[i]
      const staff1Id = typeof s1.staffId === 'string' ? s1.staffId : s1.staffId._id
      for (let j = i + 1; j < shifts.length; j++) {
        const s2 = shifts[j]
        const staff2Id = typeof s2.staffId === 'string' ? s2.staffId : s2.staffId._id
        if (staff1Id === staff2Id && s1.date === s2.date) {
          if (s1.startTime < s2.endTime && s1.endTime > s2.startTime) {
            const list1 = conflictMap.get(s1._id) || []
            list1.push(s2)
            conflictMap.set(s1._id, list1)

            const list2 = conflictMap.get(s2._id) || []
            list2.push(s1)
            conflictMap.set(s2._id, list2)
          }
        }
      }
    }
    return conflictMap
  }, [shifts])

  const totalConflictsCount = useMemo(() => {
    let count = 0
    overlappingShiftMap.forEach((conflicts) => {
      count += conflicts.length
    })
    return Math.floor(count / 2) // Each pair counted once
  }, [overlappingShiftMap])

  // Filtered shifts for display
  const displayedShifts = useMemo(() => {
    return shifts.filter((shift) => {
      const sId = typeof shift.staffId === 'string' ? shift.staffId : shift.staffId._id
      if (filterStaffId !== 'all' && sId !== filterStaffId) return false
      if (filterInconvenientOnly && !isShiftInconvenient(shift.date, shift.startTime, shift.endTime, shift.isInconvenient)) {
        return false
      }
      return true
    })
  }, [shifts, filterStaffId, filterInconvenientOnly])

  // Fetch smart suggestions when date/times change in modal
  const fetchSuggestions = useCallback(async (date: string, startTime: string, endTime: string, explicitInconv: boolean) => {
    if (!date || !startTime || !endTime || startTime >= endTime) return
    setLoadingSuggestions(true)
    try {
      const res = await request('/shifts/suggest-staff', {
        method: 'POST',
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          isInconvenient: explicitInconv,
        }),
      })
      setSuggestions(res.suggestions || [])
      // If none selected yet or current is invalid, auto-suggest top recommended
      if (res.suggestions && res.suggestions.length > 0) {
        const top = res.suggestions.find((s: StaffSuggestion) => s.status === 'recommended')
        if (top && !shiftFormSelectedStaff) {
          setShiftFormSelectedStaff(top.staffId)
        }
      }
    } catch {
      // Graceful fallback
    } finally {
      setLoadingSuggestions(false)
    }
  }, [request, shiftFormSelectedStaff])

  function openAddShiftModal(targetDate?: string) {
    const d = targetDate || localDate(weekDates[0])
    setShiftFormDate(d)
    setShiftFormStart('09:00')
    setShiftFormEnd('17:00')
    setShiftFormExplicitInconvenient(false)
    setShiftFormSelectedStaff('')
    setEditingShift(null)
    setModal('shift')
    void fetchSuggestions(d, '09:00', '17:00', false)
  }

  function openEditShiftModal(shift: Shift) {
    const staffId = typeof shift.staffId === 'string' ? shift.staffId : shift.staffId._id
    setShiftFormDate(shift.date)
    setShiftFormStart(shift.startTime)
    setShiftFormEnd(shift.endTime)
    setShiftFormExplicitInconvenient(Boolean(shift.isInconvenient))
    setShiftFormSelectedStaff(staffId)
    setEditingShift(shift)
    setModal('shift')
    void fetchSuggestions(shift.date, shift.startTime, shift.endTime, Boolean(shift.isInconvenient))
  }

  async function submitShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const staffId = shiftFormSelectedStaff || String(formData.get('staffId'))
    const date = String(formData.get('date'))
    const startTime = String(formData.get('startTime'))
    const endTime = String(formData.get('endTime'))
    const notes = String(formData.get('notes') || '')
    const explicitInconv = formData.get('isInconvenient') === 'on'

    try {
      if (editingShift) {
        await request(`/shifts/${editingShift._id}`, {
          method: 'PUT',
          body: JSON.stringify({
            staffId,
            date,
            startTime,
            endTime,
            isInconvenient: explicitInconv,
            notes,
          }),
        })
        setNotice({ kind: 'success', text: 'Shift assignment updated.' })
      } else {
        await request('/shifts', {
          method: 'POST',
          body: JSON.stringify({
            staffId,
            date,
            startTime,
            endTime,
            isInconvenient: explicitInconv,
            notes,
          }),
        })
        setNotice({ kind: 'success', text: 'Shift scheduled successfully.' })
      }
      setModal(null)
      setEditingShift(null)
      await refresh()
    } catch (error: any) {
      setNotice({ kind: 'error', text: error.message || 'Could not schedule shift.' })
    }
  }

  async function submitStaff(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const availability = formData.getAll('availability').map(Number)
    const name = String(formData.get('name'))
    const role = String(formData.get('role') || 'Team member')
    const maxWeeklyHours = Number(formData.get('maxWeeklyHours') || 40)
    const color = String(formData.get('color') || COLORS[staff.length % COLORS.length])
    const inconvenientPreference = String(formData.get('inconvenientPreference') || 'neutral')

    try {
      await request('/staff', {
        method: 'POST',
        body: JSON.stringify({
          name,
          role,
          availability,
          maxWeeklyHours,
          color,
          inconvenientPreference,
        }),
      })
      setModal(null)
      if (await refresh()) setNotice({ kind: 'success', text: `Team member ${name} added!` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not add team member.' })
    }
  }

  async function saveAvailability(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingStaff) return
    const formData = new FormData(event.currentTarget)
    const availability = formData.getAll('availability').map(Number)
    const role = String(formData.get('role') || editingStaff.role)
    const maxWeeklyHours = Number(formData.get('maxWeeklyHours') || editingStaff.maxWeeklyHours || 40)
    const inconvenientPreference = String(formData.get('inconvenientPreference') || editingStaff.inconvenientPreference || 'neutral')
    const color = String(formData.get('color') || editingStaff.color || '#7b66e8')

    try {
      await request(`/staff/${editingStaff._id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editingStaff.name,
          role,
          availability,
          maxWeeklyHours,
          inconvenientPreference,
          color,
        }),
      })
      setModal(null)
      setEditingStaff(null)
      if (await refresh()) setNotice({ kind: 'success', text: `${editingStaff.name}’s settings updated.` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not update team member.' })
    }
  }

  async function deleteStaffMember(staffId: string, staffName: string) {
    if (!window.confirm(`Are you sure you want to remove ${staffName} and all their assigned shifts?`)) return
    try {
      await request(`/staff/${staffId}`, { method: 'DELETE' })
      if (await refresh()) setNotice({ kind: 'success', text: `${staffName} removed.` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not remove staff member.' })
    }
  }

  async function deleteShift(shiftId: string) {
    try {
      await request(`/shifts/${shiftId}`, { method: 'DELETE' })
      if (await refresh()) setNotice({ kind: 'success', text: 'Shift removed from the schedule.' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not remove shift.' })
    }
  }

  async function seedSampleData() {
    try {
      await request('/seed', { method: 'POST' })
      setNotice({ kind: 'success', text: 'Realistic team and fair rota seeded successfully!' })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to seed sample data.' })
    }
  }

  async function saveOperatingHours(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const start = String(formData.get('start'))
    const end = String(formData.get('end'))

    try {
      const res = await request('/operating-hours', {
        method: 'PUT',
        body: JSON.stringify({ start, end }),
      })
      setOperatingHours(res)
      setModal(null)
      if (await refresh()) setNotice({ kind: 'success', text: `Operating hours updated: ${start} – ${end}` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to save operating hours.' })
    }
  }

  const teamMetrics = summaryData?.teamMetrics
  const staffSummaries = summaryData?.staffSummaries || []

  // Coverage statistics for top stats
  const overallCoverage = coverageData?.overallPercent ?? 100

  return (
    <div className="app-shell">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="StaffShift home">
          <span className="brand-mark"><Icon name="spark" size={19} /></span>
          <span>staffshift<span className="brand-period">.</span></span>
        </a>

        <div className="workspace-label">ROTA WORKSPACE</div>

        <nav className="side-nav" aria-label="Main navigation">
          <button
            className={`nav-item ${activeTab === 'schedule' ? 'active' : ''}`}
            onClick={() => setActiveTab('schedule')}
          >
            <Icon name="calendar" /> Schedule
          </button>
          <button
            className={`nav-item ${activeTab === 'fairness' ? 'active' : ''}`}
            onClick={() => setActiveTab('fairness')}
          >
            <Icon name="chart" /> Fairness & Balance
            {teamMetrics && teamMetrics.teamFairnessIndex < 80 && (
              <span className="nav-badge alert">!</span>
            )}
          </button>
          <button
            className={`nav-item ${activeTab === 'coverage' ? 'active' : ''}`}
            onClick={() => setActiveTab('coverage')}
          >
            <Icon name="clock" /> Operating Hours
            <span className="nav-badge">{overallCoverage}%</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'team' ? 'active' : ''}`}
            onClick={() => setActiveTab('team')}
          >
            <Icon name="people" /> Team ({staff.length})
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="week-coverage">
            <div className="coverage-header">
              <span className="coverage-icon"><Icon name="shield" size={15} /></span>
              <strong>Fairness Guard</strong>
            </div>
            <div className="fairness-meter-wrapper">
              <div className="fairness-meter-bar">
                <span
                  style={{
                    width: `${teamMetrics?.teamFairnessIndex ?? 100}%`,
                    backgroundColor: (teamMetrics?.teamFairnessIndex ?? 100) >= 80 ? '#5cbd93' : '#e58a53',
                  }}
                />
              </div>
              <span className="fairness-score-text">
                {teamMetrics?.teamFairnessIndex ?? 100}% · {teamMetrics?.balanceGrade ?? 'Balanced'}
              </span>
            </div>
            <p className="coverage-tip">No team member gets overwhelmed with inconvenient shifts.</p>
          </div>

          <div className="profile">
            <div className="profile-avatar">SS</div>
            <div>
              <strong>Operating Team</strong>
              <span>{operatingHours.start} – {operatingHours.end}</span>
            </div>
            <button
              className="settings-quick-btn"
              title="Edit operating hours"
              onClick={() => setModal('operatingHours')}
            >
              <Icon name="clock" size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            StaffShift Fairness <span>/</span>
            <strong style={{ color: '#4b4863', marginLeft: '6px' }}>
              {activeTab === 'schedule' && 'Weekly Rota Schedule'}
              {activeTab === 'fairness' && 'Fairness & Distribution Report'}
              {activeTab === 'coverage' && 'Operating Hours Coverage'}
              {activeTab === 'team' && 'Team Availability & Settings'}
            </strong>
          </div>

          <div className="topbar-right">
            <span className="live-indicator">
              <i className={apiConnected ? '' : 'disconnected'} />
              {apiConnected
                ? `API Live (${storageType === 'mongodb' ? 'MongoDB' : 'Local Dev Store'})`
                : 'Connecting to API...'}
            </span>

            <button
              className="button button-secondary demo-seed-button"
              onClick={seedSampleData}
              title="Preload sample staff and balanced shifts"
            >
              <Icon name="spark" size={14} /> Load Demo Team
            </button>

            <button
              className="button button-primary"
              onClick={() => (staff.length ? openAddShiftModal() : setModal('staff'))}
            >
              <Icon name="plus" size={16} /> {staff.length ? 'Add Shift' : 'Add Staff'}
            </button>
          </div>
        </header>

        <div className="page-content">
          {/* Notifications Banner */}
          {notice && (
            <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.kind === 'error' && <Icon name="alert" size={18} />}
              {notice.kind === 'success' && <Icon name="check" size={18} />}
              <div className="notice-body">{notice.text}</div>
              {notice.kind === 'error' && (
                <button
                  className="notice-retry"
                  onClick={async () => {
                    if (await refresh()) setNotice(null)
                  }}
                >
                  Retry
                </button>
              )}
              <button
                className="notice-close"
                aria-label="Dismiss message"
                onClick={() => setNotice(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}

          {/* Overlap Conflict Alert Banner */}
          {totalConflictsCount > 0 && (
            <div className="conflict-banner" role="alert">
              <div className="conflict-icon"><Icon name="alert" size={19} /></div>
              <div className="conflict-content">
                <strong>Schedule Conflict Detected: {totalConflictsCount} Overlapping Shift(s)</strong>
                <p>One or more staff members are assigned overlapping shifts on the same day. Please review highlighted shifts in the rota.</p>
              </div>
              <button
                className="button button-sm button-conflict"
                onClick={() => setActiveTab('schedule')}
              >
                View Conflicts
              </button>
            </div>
          )}

          {/* Quick Stats Grid */}
          <section className="stats-grid" aria-label="Key rota statistics">
            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon violet"><Icon name="calendar" /></span>
                <span className="stat-caption">SCHEDULED SHIFTS</span>
              </div>
              <strong className="stat-value">{shifts.length}</strong>
              <span className="stat-label">
                {teamMetrics ? `${teamMetrics.totalHours} total working hours` : 'Total planned shifts'}
              </span>
              <span className="stat-foot">
                <span className="foot-dot violet-dot" /> Across {staff.length} team members
              </span>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon orange"><Icon name="moon" /></span>
                <span className="stat-caption">INCONVENIENT SHIFTS</span>
              </div>
              <strong className="stat-value">
                {teamMetrics?.totalInconvenientShifts ?? 0}
                <small>shifts</small>
              </strong>
              <span className="stat-label">Closing, early & weekend shifts</span>
              <span className="stat-foot">
                <span className="foot-dot orange-dot" />
                Avg {teamMetrics?.avgInconvenientPerPerson ?? 0} per person
              </span>
            </article>

            <article className={`stat-card ${(teamMetrics?.teamFairnessIndex ?? 100) < 70 ? 'stat-alert' : ''}`}>
              <div className="stat-top">
                <span className={`stat-icon ${(teamMetrics?.teamFairnessIndex ?? 100) >= 80 ? 'green' : 'orange'}`}>
                  <Icon name="shield" />
                </span>
                <span className="stat-caption">FAIRNESS RATING</span>
              </div>
              <strong className="stat-value">
                {teamMetrics?.teamFairnessIndex ?? 100}%
                <small style={{ fontSize: '12px', marginLeft: '6px' }}>{teamMetrics?.balanceGrade ?? 'Balanced'}</small>
              </strong>
              <span className="stat-label">Equity across inconvenient shifts</span>
              <span className="stat-foot">
                <span className={`foot-dot ${(teamMetrics?.teamFairnessIndex ?? 100) >= 80 ? 'green-dot' : 'orange-dot'}`} />
                {(teamMetrics?.teamFairnessIndex ?? 100) >= 80 ? 'Balanced burden' : 'Disproportionate shifts'}
              </span>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-icon blue"><Icon name="clock" /></span>
                <span className="stat-caption">OPERATING COVERAGE</span>
              </div>
              <strong className="stat-value">{overallCoverage}%</strong>
              <span className="stat-label">
                Target: {operatingHours.start} – {operatingHours.end} daily
              </span>
              <span className="stat-foot">
                <span className="foot-dot blue-dot" />
                {overallCoverage === 100 ? 'Operating hours 100% covered' : 'Coverage gaps detected'}
              </span>
            </article>
          </section>

          {/* TAB 1: SCHEDULE VIEW */}
          {activeTab === 'schedule' && (
            <section className="panel schedule-panel" id="schedule">
              <div className="panel-heading schedule-heading">
                <div className="schedule-title-area">
                  <h2>Team Rota Schedule</h2>
                  <p>Covering team operating hours fairly without double-booking</p>
                </div>

                <div className="schedule-actions-row">
                  {/* Filters */}
                  <div className="filter-group">
                    <span className="filter-label"><Icon name="filter" size={13} /> Filter:</span>
                    <select
                      className="filter-select"
                      value={filterStaffId}
                      onChange={(e) => setFilterStaffId(e.target.value)}
                    >
                      <option value="all">All Staff ({staff.length})</option>
                      {staff.map((s) => (
                        <option value={s._id} key={s._id}>{s.name}</option>
                      ))}
                    </select>

                    <label className="checkbox-filter-label">
                      <input
                        type="checkbox"
                        checked={filterInconvenientOnly}
                        onChange={(e) => setFilterInconvenientOnly(e.target.checked)}
                      />
                      <span>Inconvenient Only</span>
                    </label>
                  </div>

                  {/* Week navigation */}
                  <div className="week-controls">
                    <button
                      className="icon-button"
                      aria-label="Previous week"
                      onClick={() => setWeek((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7))}
                    >
                      <Icon name="chevronLeft" />
                    </button>
                    <span className="week-label">{weekLabel}</span>
                    <button
                      className="icon-button"
                      aria-label="Next week"
                      onClick={() => setWeek((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7))}
                    >
                      <Icon name="chevronRight" />
                    </button>
                    <button className="today-button" onClick={() => setWeek(mondayOf(new Date()))}>
                      Current Week
                    </button>
                  </div>
                </div>
              </div>

              {/* 7-Day Calendar Grid */}
              <div className="calendar-grid" role="grid" aria-label={`Schedule for ${weekLabel}`}>
                {weekDates.map((date) => {
                  const key = localDate(date)
                  const dayShifts = displayedShifts
                    .filter((s) => s.date === key)
                    .sort((a, b) => a.startTime.localeCompare(b.startTime))

                  const dayCoverage = coverageData?.days.find((d) => d.date === key)
                  const dayHours = dayShifts.reduce((acc, s) => acc + calculateHours(s.startTime, s.endTime), 0)

                  return (
                    <div className={`day-column ${key === today ? 'is-today' : ''}`} role="gridcell" key={key}>
                      <div className="day-header">
                        <div className="day-header-top">
                          <span className="day-name">{DAYS[date.getDay()]}</span>
                          <span className="day-number">{date.getDate()}</span>
                        </div>
                        <div className="day-sub-metrics">
                          <span className="day-hours-badge">{Math.round(dayHours * 10) / 10}h</span>
                          {dayCoverage && (
                            <span className={`day-cov-pill ${dayCoverage.coveragePercent >= 90 ? 'cov-good' : 'cov-low'}`}>
                              {dayCoverage.coveragePercent}%
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="day-shifts">
                        {dayShifts.map((shift) => {
                          const person = staffForShift(shift, staff)
                          const color = person?.color || COLORS[0]
                          const hours = calculateHours(shift.startTime, shift.endTime)
                          const hasConflict = overlappingShiftMap.has(shift._id)
                          const isInconv = isShiftInconvenient(shift.date, shift.startTime, shift.endTime, shift.isInconvenient)

                          return (
                            <article
                              className={`shift-card ${hasConflict ? 'shift-conflict-alert' : ''} ${isInconv ? 'shift-inconvenient' : ''}`}
                              key={shift._id}
                              style={{ '--shift-color': color } as React.CSSProperties}
                            >
                              <div className="shift-card-header">
                                <span className="shift-person-dot" style={{ backgroundColor: color }} />
                                <strong>{person?.name ?? 'Assigned Staff'}</strong>
                                <div className="shift-card-actions">
                                  <button
                                    className="edit-shift-btn"
                                    aria-label="Edit shift"
                                    onClick={() => openEditShiftModal(shift)}
                                    title="Edit shift"
                                  >
                                    <Icon name="edit" size={12} />
                                  </button>
                                  <button
                                    className="delete-shift-btn"
                                    aria-label={`Remove shift for ${person?.name ?? 'staff'}`}
                                    onClick={() => void deleteShift(shift._id)}
                                    title="Remove shift"
                                  >
                                    <Icon name="close" size={12} />
                                  </button>
                                </div>
                              </div>

                              <div className="shift-time-row">
                                <span className="shift-time">{shift.startTime} – {shift.endTime}</span>
                                <span className="shift-duration-badge">{hours}h</span>
                              </div>

                              <div className="shift-role-row">
                                <span className="shift-role">{person?.role ?? 'Team'}</span>
                              </div>

                              {/* Badges */}
                              <div className="shift-badges-row">
                                {hasConflict && (
                                  <span className="badge badge-conflict" title="Double booking conflict for this staff member!">
                                    <Icon name="alert" size={10} /> Overlap
                                  </span>
                                )}
                                {shift.shiftType === 'closing' && (
                                  <span className="badge badge-closing"><Icon name="moon" size={10} /> Closing</span>
                                )}
                                {shift.shiftType === 'opening' && (
                                  <span className="badge badge-opening"><Icon name="sun" size={10} /> Opening</span>
                                )}
                                {shift.shiftType === 'weekend' && (
                                  <span className="badge badge-weekend">Weekend</span>
                                )}
                                {shift.isInconvenient && shift.shiftType !== 'closing' && shift.shiftType !== 'opening' && shift.shiftType !== 'weekend' && (
                                  <span className="badge badge-inconvenient">Inconvenient</span>
                                )}
                              </div>
                            </article>
                          )
                        })}

                        {dayShifts.length === 0 && (
                          <div className="empty-day-state">
                            <span className="empty-day-text">No shifts</span>
                            <button
                              className="add-day-shift-btn"
                              onClick={() => openAddShiftModal(key)}
                            >
                              + Add
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="day-column-foot">
                        <button
                          className="quick-add-foot-btn"
                          onClick={() => openAddShiftModal(key)}
                          title={`Schedule shift on ${DAYS[date.getDay()]}`}
                        >
                          <Icon name="plus" size={12} /> Shift
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="schedule-footer">
                <div className="legend-items">
                  <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#7562dc' }} /> Standard</span>
                  <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#e58a53' }} /> 🌙 Closing / Inconvenient</span>
                  <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#48a88b' }} /> 🌅 Opening</span>
                  <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#d46d79' }} /> ⚠️ Overlap Conflict</span>
                </div>
                <div className="footer-stats">
                  <span>{displayedShifts.length} of {shifts.length} shifts displayed</span>
                </div>
              </div>
            </section>
          )}

          {/* TAB 2: FAIRNESS & DISTRIBUTION */}
          {activeTab === 'fairness' && (
            <div className="fairness-dashboard-grid">
              <section className="panel fairness-summary-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Team Shift Distribution & Fairness Index</h2>
                    <p>Preventing burn-out by equitably sharing inconvenient hours and weekend shifts</p>
                  </div>
                  <span className="fairness-gauge-badge">
                    Score: <strong>{teamMetrics?.teamFairnessIndex ?? 100}%</strong>
                  </span>
                </div>

                {/* Recommendations Banner */}
                {summaryData?.recommendations && summaryData.recommendations.length > 0 && (
                  <div className="recommendations-box">
                    <div className="rec-heading">
                      <Icon name="spark" size={17} />
                      <strong>Fairness Balancing Recommendations:</strong>
                    </div>
                    <ul className="rec-list">
                      {summaryData.recommendations.map((rec, i) => (
                        <li key={i}>{rec}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Per-Staff Distribution Cards */}
                <div className="staff-fairness-list">
                  {staffSummaries.length === 0 ? (
                    <div className="empty-state">
                      <Icon name="chart" size={32} />
                      <strong>No staff members registered</strong>
                      <span>Add your team to start tracking shift fairness.</span>
                    </div>
                  ) : (
                    staffSummaries.map((person) => {
                      const maxInconvInTeam = Math.max(1, ...staffSummaries.map((s) => s.inconvenientShifts))
                      const inconvPercent = Math.round((person.inconvenientShifts / maxInconvInTeam) * 100)
                      const isHighLoad = teamMetrics && person.inconvenientShifts > (teamMetrics.avgInconvenientPerPerson + 1)

                      return (
                        <div className={`staff-fairness-card ${isHighLoad ? 'high-load-warning' : ''}`} key={person.staffId}>
                          <div className="staff-info-col">
                            <span className="person-avatar" style={{ backgroundColor: person.color }}>
                              {initials(person.name)}
                            </span>
                            <div>
                              <strong>{person.name}</strong>
                              <span className="staff-role-sub">{person.role}</span>
                            </div>
                          </div>

                          <div className="metric-pills-col">
                            <div className="metric-pill">
                              <span className="pill-label">Total Shifts</span>
                              <strong>{person.totalShifts}</strong>
                            </div>
                            <div className="metric-pill">
                              <span className="pill-label">Hours</span>
                              <strong>{person.totalHours}h <small>/ {person.maxWeeklyHours}h</small></strong>
                            </div>
                            <div className={`metric-pill ${person.inconvenientShifts > 1 ? 'pill-alert' : ''}`}>
                              <span className="pill-label">Inconvenient</span>
                              <strong>{person.inconvenientShifts} shifts</strong>
                            </div>
                            <div className="metric-pill">
                              <span className="pill-label">Weekend</span>
                              <strong>{person.weekendShifts}</strong>
                            </div>
                          </div>

                          <div className="inconv-bar-col">
                            <div className="inconv-bar-label">
                              <span>Inconvenient share:</span>
                              <strong>{person.inconvenientShifts} of {teamMetrics?.totalInconvenientShifts ?? 0} team shifts</strong>
                            </div>
                            <div className="progress-track">
                              <span
                                style={{
                                  width: `${inconvPercent}%`,
                                  backgroundColor: isHighLoad ? '#e58a53' : person.color,
                                }}
                              />
                            </div>
                          </div>

                          <div className="fairness-status-col">
                            <span className={`fairness-score-pill ${person.fairnessScore >= 80 ? 'score-good' : 'score-warn'}`}>
                              {person.fairnessScore}% Balanced
                            </span>
                            {person.flags.length > 0 && (
                              <span className="flag-badge" title={person.flags.join(', ')}>
                                <Icon name="alert" size={12} /> {person.flags[0]}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </section>
            </div>
          )}

          {/* TAB 3: OPERATING HOURS & COVERAGE */}
          {activeTab === 'coverage' && (
            <section className="panel coverage-panel">
              <div className="panel-heading">
                <div>
                  <h2>Operating Hours Coverage Tracker</h2>
                  <p>Operating target: {operatingHours.start} to {operatingHours.end} daily</p>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() => setModal('operatingHours')}
                >
                  <Icon name="clock" size={14} /> Adjust Operating Hours
                </button>
              </div>

              <div className="coverage-days-list">
                {coverageData?.days.map((day) => (
                  <div className="coverage-day-row" key={day.date}>
                    <div className="day-name-box">
                      <strong>{day.dayName}</strong>
                      <span>{day.date}</span>
                      <span className={`cov-badge ${day.coveragePercent >= 90 ? 'good' : 'gap'}`}>
                        {day.coveragePercent}% Covered
                      </span>
                    </div>

                    <div className="hourly-timeline">
                      {day.hourlySlots.map((slot) => (
                        <div
                          className={`hour-slot ${slot.covered ? 'slot-covered' : 'slot-gap'}`}
                          key={slot.time}
                          title={`${slot.time} – ${slot.covered ? `Covered by: ${slot.staffNames.join(', ')}` : 'UNCOVERED GAP!'}`}
                        >
                          <span className="slot-time-text">{slot.time}</span>
                          <span className="slot-status-indicator">
                            {slot.covered ? slot.staffCount : '!'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="coverage-legend">
                <div className="legend-item"><span className="legend-box covered" /> Covered (Staff on duty)</div>
                <div className="legend-item"><span className="legend-box gap" /> Operating Hours Gap (Need shift!)</div>
              </div>
            </section>
          )}

          {/* TAB 4: TEAM AVAILABILITY & SETTINGS */}
          {activeTab === 'team' && (
            <section className="panel team-management-panel">
              <div className="panel-heading">
                <div>
                  <h2>Team Members & Work Availability</h2>
                  <p>Manage staff availability, weekly hour limits, and shift preferences</p>
                </div>
                <button className="button button-primary" onClick={() => setModal('staff')}>
                  <Icon name="plus" size={16} /> Add Team Member
                </button>
              </div>

              <div className="team-cards-grid">
                {staff.map((person) => (
                  <article className="team-profile-card" key={person._id}>
                    <div className="card-top-row">
                      <span className="person-avatar" style={{ backgroundColor: person.color }}>
                        {initials(person.name)}
                      </span>
                      <div className="person-details">
                        <strong>{person.name}</strong>
                        <span className="person-role">{person.role}</span>
                      </div>
                      <div className="card-actions">
                        <button
                          className="icon-button"
                          onClick={() => { setEditingStaff(person); setModal('availability') }}
                          title="Edit availability"
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        <button
                          className="icon-button delete-person-btn"
                          onClick={() => deleteStaffMember(person._id, person.name)}
                          title="Remove staff member"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>

                    <div className="card-metrics-row">
                      <div className="card-metric">
                        <span>Max Hours:</span>
                        <strong>{person.maxWeeklyHours || 40}h / week</strong>
                      </div>
                      <div className="card-metric">
                        <span>Inconvenient:</span>
                        <strong className={`pref-${person.inconvenientPreference || 'neutral'}`}>
                          {person.inconvenientPreference === 'willing' ? 'Willing' : person.inconvenientPreference === 'prefer_not' ? 'Avoid' : 'Neutral'}
                        </strong>
                      </div>
                    </div>

                    <div className="availability-matrix">
                      <span className="matrix-title">Available Days:</span>
                      <div className="matrix-days">
                        {WEEKDAYS.map((day, idx) => {
                          const weekday = (idx + 1) % 7
                          const isAvailable = person.availability.includes(weekday)
                          return (
                            <span
                              key={day}
                              className={`matrix-day-chip ${isAvailable ? 'available' : 'unavailable'}`}
                              title={`${day}: ${isAvailable ? 'Available' : 'Unavailable'}`}
                            >
                              {day.slice(0, 3)}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <footer className="page-footer">
            <span>StaffShift Fairness · Designed for high morale, transparent schedules, and zero burnt-out team members.</span>
            <span>REST API + MongoDB Persistence · Overlap Protection Active</span>
          </footer>
        </div>
      </main>

      {/* MODAL: ADD / EDIT SHIFT WITH SMART FAIR SUGGESTER */}
      {modal === 'shift' && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null) }}>
          <section className="modal shift-modal-expanded" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-heading">
              <div>
                <span className="modal-kicker">FAIR ROTA SCHEDULING</span>
                <h2 id="modal-title">{editingShift ? 'Edit Shift Assignment' : 'Schedule New Shift'}</h2>
              </div>
              <button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}>
                <Icon name="close" />
              </button>
            </div>

            <form className="form" onSubmit={submitShift}>
              {/* Date & Time Pickers */}
              <div className="form-row">
                <label>
                  Shift Date
                  <input
                    type="date"
                    name="date"
                    required
                    value={shiftFormDate}
                    onChange={(e) => {
                      setShiftFormDate(e.target.value)
                      void fetchSuggestions(e.target.value, shiftFormStart, shiftFormEnd, shiftFormExplicitInconvenient)
                    }}
                  />
                </label>
                <div className="time-range-group">
                  <label>
                    Start Time
                    <input
                      type="time"
                      name="startTime"
                      required
                      value={shiftFormStart}
                      onChange={(e) => {
                        setShiftFormStart(e.target.value)
                        void fetchSuggestions(shiftFormDate, e.target.value, shiftFormEnd, shiftFormExplicitInconvenient)
                      }}
                    />
                  </label>
                  <label>
                    End Time
                    <input
                      type="time"
                      name="endTime"
                      required
                      value={shiftFormEnd}
                      onChange={(e) => {
                        setShiftFormEnd(e.target.value)
                        void fetchSuggestions(shiftFormDate, shiftFormStart, e.target.value, shiftFormExplicitInconvenient)
                      }}
                    />
                  </label>
                </div>
              </div>

              {/* Inconvenient Shift Detection Banner */}
              <div className="inconvenient-detector-banner">
                <label className="checkbox-toggle">
                  <input
                    type="checkbox"
                    name="isInconvenient"
                    checked={shiftFormExplicitInconvenient || isShiftInconvenient(shiftFormDate, shiftFormStart, shiftFormEnd)}
                    onChange={(e) => {
                      setShiftFormExplicitInconvenient(e.target.checked)
                      void fetchSuggestions(shiftFormDate, shiftFormStart, shiftFormEnd, e.target.checked)
                    }}
                  />
                  <span>
                    <strong>Mark as Inconvenient / Demanding Shift</strong>
                    <small>
                      {isShiftInconvenient(shiftFormDate, shiftFormStart, shiftFormEnd)
                        ? ' (Automatically flagged due to early, night, or weekend timing)'
                        : ' (Check to track fairness for this heavy rush or demanding shift)'}
                    </small>
                  </span>
                </label>
              </div>

              {/* SMART FAIRNESS-AWARE STAFF SUGGESTER */}
              <div className="smart-suggester-container">
                <div className="suggester-header">
                  <span className="suggester-title"><Icon name="spark" size={15} /> Fairness Staff Suggester</span>
                  <span className="suggester-subtitle">Ranked by fairness to balance inconvenient shifts:</span>
                </div>

                {loadingSuggestions ? (
                  <div className="suggester-loading">Checking availability and fairness balance...</div>
                ) : suggestions.length === 0 ? (
                  <div className="suggester-empty">Choose date and times to see recommended team members.</div>
                ) : (
                  <div className="suggestions-list">
                    {suggestions.map((sug) => {
                      const isSelected = shiftFormSelectedStaff === sug.staffId
                      return (
                        <div
                          key={sug.staffId}
                          className={`suggestion-item status-${sug.status} ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => {
                            if (sug.status !== 'conflict' && sug.status !== 'unavailable') {
                              setShiftFormSelectedStaff(sug.staffId)
                            }
                          }}
                        >
                          <div className="sug-left">
                            <span className="person-avatar-sm" style={{ backgroundColor: sug.color }}>
                              {initials(sug.name)}
                            </span>
                            <div className="sug-info">
                              <strong>{sug.name} <small>({sug.role})</small></strong>
                              <span className="sug-reasons">
                                {sug.reasons.join(' · ')}
                              </span>
                            </div>
                          </div>

                          <div className="sug-right">
                            <span className="sug-load-text">
                              {sug.currentWeekHours}h · {sug.currentWeekInconvenient} inconv
                            </span>
                            {sug.status === 'recommended' && (
                              <span className="sug-badge badge-rec"><Icon name="check" size={11} /> Top Pick</span>
                            )}
                            {sug.status === 'caution' && (
                              <span className="sug-badge badge-caut">Heavy Load</span>
                            )}
                            {sug.status === 'conflict' && (
                              <span className="sug-badge badge-conf">Overlap Conflict</span>
                            )}
                            {sug.status === 'unavailable' && (
                              <span className="sug-badge badge-unav">Unavailable</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Fallback Direct Select */}
              <label>
                Assigned Team Member:
                <select
                  name="staffId"
                  required
                  value={shiftFormSelectedStaff}
                  onChange={(e) => setShiftFormSelectedStaff(e.target.value)}
                >
                  <option value="" disabled>Select team member</option>
                  {staff.map((person) => (
                    <option value={person._id} key={person._id}>
                      {person.name} · {person.role} ({person.maxWeeklyHours || 40}h limit)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Shift Notes / Workstation
                <input
                  name="notes"
                  placeholder="e.g. Front registers, Opening checklist, Espresso bar"
                  defaultValue={editingShift?.notes || ''}
                />
              </label>

              <button className="button button-primary form-submit" type="submit">
                <Icon name="check" size={17} /> {editingShift ? 'Save Changes' : 'Confirm & Schedule Shift'}
              </button>
            </form>
          </section>
        </div>
      )}

      {/* MODAL: ADD TEAM MEMBER */}
      {modal === 'staff' && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null) }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-staff-title">
            <div className="modal-heading">
              <div>
                <span className="modal-kicker">TEAM ROSTER</span>
                <h2 id="modal-staff-title">Add Team Member</h2>
              </div>
              <button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}>
                <Icon name="close" />
              </button>
            </div>

            <form className="form" onSubmit={submitStaff}>
              <label>
                Full Name
                <input name="name" required maxLength={80} placeholder="e.g. Jordan Miller" autoFocus />
              </label>

              <div className="form-row">
                <label>
                  Role / Title
                  <input name="role" maxLength={60} placeholder="e.g. Barista / Floor Lead" defaultValue="Team member" />
                </label>
                <label>
                  Max Weekly Hours
                  <input type="number" name="maxWeeklyHours" min={1} max={80} defaultValue={40} />
                </label>
              </div>

              <label>
                Inconvenient Shift Preference
                <select name="inconvenientPreference" defaultValue="neutral">
                  <option value="willing">Willing to take closing & weekend shifts</option>
                  <option value="neutral">Neutral / Standard fair share</option>
                  <option value="prefer_not">Prefers to avoid inconvenient shifts</option>
                </select>
              </label>

              <fieldset className="availability-fieldset">
                <legend>Available Days of the Week</legend>
                <div className="day-checkboxes">
                  {WEEKDAYS.map((day, index) => (
                    <label className="day-checkbox" key={day}>
                      <input
                        type="checkbox"
                        name="availability"
                        value={(index + 1) % 7}
                        defaultChecked={index < 5}
                      />
                      <span>{day.slice(0, 3)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <button className="button button-primary form-submit" type="submit">
                <Icon name="plus" size={17} /> Add Team Member
              </button>
            </form>
          </section>
        </div>
      )}

      {/* MODAL: EDIT AVAILABILITY & SETTINGS */}
      {modal === 'availability' && editingStaff && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null) }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-avail-title">
            <div className="modal-heading">
              <div>
                <span className="modal-kicker">WORK PREFERENCES</span>
                <h2 id="modal-avail-title">{editingStaff.name}’s Availability</h2>
              </div>
              <button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}>
                <Icon name="close" />
              </button>
            </div>

            <form className="form" onSubmit={saveAvailability}>
              <div className="form-row">
                <label>
                  Role
                  <input name="role" defaultValue={editingStaff.role} />
                </label>
                <label>
                  Max Weekly Hours
                  <input
                    type="number"
                    name="maxWeeklyHours"
                    min={1}
                    max={80}
                    defaultValue={editingStaff.maxWeeklyHours || 40}
                  />
                </label>
              </div>

              <label>
                Inconvenient Shift Preference
                <select name="inconvenientPreference" defaultValue={editingStaff.inconvenientPreference || 'neutral'}>
                  <option value="willing">Willing to take closing & weekend shifts</option>
                  <option value="neutral">Neutral / Standard fair share</option>
                  <option value="prefer_not">Prefers to avoid inconvenient shifts</option>
                </select>
              </label>

              <fieldset className="availability-fieldset">
                <legend>Available Days</legend>
                <div className="day-checkboxes">
                  {WEEKDAYS.map((day, index) => {
                    const weekday = (index + 1) % 7
                    return (
                      <label className="day-checkbox" key={day}>
                        <input
                          type="checkbox"
                          name="availability"
                          value={weekday}
                          defaultChecked={editingStaff.availability.includes(weekday)}
                        />
                        <span>{day.slice(0, 3)}</span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <button className="button button-primary form-submit" type="submit">
                Save Team Member Settings
              </button>
            </form>
          </section>
        </div>
      )}

      {/* MODAL: OPERATING HOURS CONFIGURATION */}
      {modal === 'operatingHours' && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null) }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-op-title">
            <div className="modal-heading">
              <div>
                <span className="modal-kicker">STORE / TEAM HOURS</span>
                <h2 id="modal-op-title">Team Operating Hours</h2>
              </div>
              <button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}>
                <Icon name="close" />
              </button>
            </div>

            <form className="form" onSubmit={saveOperatingHours}>
              <p className="modal-help">
                Operating hours define the hours your business needs covered each day. Shifts will be checked against this window.
              </p>
              <div className="form-row">
                <label>
                  Opening Time
                  <input type="time" name="start" required defaultValue={operatingHours.start} />
                </label>
                <label>
                  Closing Time
                  <input type="time" name="end" required defaultValue={operatingHours.end} />
                </label>
              </div>

              <button className="button button-primary form-submit" type="submit">
                Save Operating Hours
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
