import { dataSourceOptions } from './data-source';

describe('the data source contract', () => {
  it('runs migrations at boot', () => {
    // Without this the pod boots against whatever schema happens to be there.
    // Both session_previews migrations were written and neither ran: the
    // table existed only because it had been applied by hand, and
    // selectedSourceRef was simply absent until someone noticed. A schema
    // mismatch then surfaces as a runtime query error on the first request
    // that touches the new column, long after the deploy reported success.
    expect(dataSourceOptions.migrationsRun).toBe(true);
  });

  it('never lets the ORM diff a live database', () => {
    // synchronize and migrationsRun are not alternatives. One is a reviewed,
    // ordered, forward-only script; the other is the ORM guessing, and it is
    // how a column gets dropped during a rollout.
    expect(dataSourceOptions.synchronize).toBe(false);
  });

  it('registers every entity the app persists', () => {
    const names = dataSourceOptions.entities.map((entity) => entity.name).sort();
    expect(names).toEqual([
      'Agent',
      'AuthSession',
      'Command',
      'Manifest',
      'Session',
      'SessionPreview',
      'Track',
    ]);
  });
});
