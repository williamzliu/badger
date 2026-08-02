import { Candidate } from '../shared/types.js';

/**
 * TODO(demo): Replace these fixtures with the four manually verified showings
 * for the actual Badger demo. These are intentionally fictional and must not
 * be presented as live cinema inventory.
 */
export const mockCandidates: Candidate[] = [
  { id: 'mock_friday_imax', theater: 'Mock Theater A', time: 'Friday 9:20 PM', slot: 'friday_after_8', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_saturday_day', theater: 'Mock Theater B', time: 'Saturday 2:10 PM', slot: 'saturday_afternoon', format: 'Standard', price: 19, location: 'San Francisco' },
  { id: 'mock_saturday_imax', theater: 'Mock Theater A', time: 'Saturday 8:30 PM', slot: 'saturday_evening', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_sunday_day', theater: 'Mock Theater C', time: 'Sunday 4:00 PM', slot: 'sunday_afternoon', format: 'Standard', price: 18, location: 'San Francisco' }
];
