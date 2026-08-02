import { Candidate } from '../shared/types.js';

/** Controlled demo fixtures, not a live ticketing feed. Reverify showtimes
 * before presenting the demo as current cinema inventory. */
export const mockCandidates: Candidate[] = [
  { id: 'mock_friday_imax', theater: 'AMC Metreon', time: 'Friday 9:20 PM', slot: 'friday_after_8', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_saturday_day', theater: 'Regal Stonestown', time: 'Saturday 2:10 PM', slot: 'saturday_afternoon', format: 'Standard', price: 19, location: 'San Francisco' },
  { id: 'mock_saturday_imax', theater: 'AMC Metreon', time: 'Saturday 8:30 PM', slot: 'saturday_evening', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_sunday_day', theater: 'Alamo Drafthouse New Mission', time: 'Sunday 4:00 PM', slot: 'sunday_afternoon', format: 'Standard', price: 18, location: 'San Francisco' }
];
