// Invented submissions in the JotForm API shape. No real people.
export const OUTING = 'Outing (\xa0events, movies, Sr Center,\xa0 etc.)'

export const villagesByName = new Map([['Aquidneck Island', '7'], ['Bristol', '8']])

export function submission(overrides = {}) {
  const { answers = {}, ...rest } = overrides
  return {
    id: '5000000000000000001',
    created_at: '2026-11-02 09:30:00',
    updated_at: '2026-11-03 10:00:00',
    status: 'ACTIVE',
    answers: {
      2: { answer: { first: 'Jane', last: 'Doe' } },
      3: { answer: { first: 'John', last: 'Roe' } },
      4: { answer: { datetime: '2026-11-01 00:00:00', year: '2026' } },
      5: { answer: '45' },
      6: { answer: 'Phone call' },
      8: { answer: 'Chatted about the garden.' },
      10: { answer: 'Aquidneck Island' },
      13: { answer: { datetime: '2026-11-01 00:00:00' } },
      21: { answer: ['Pet visit', 'Dining out'] },
      23: { answer: 'jane.doe@example.org' },
      ...answers
    },
    ...rest
  }
}
