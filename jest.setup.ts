// TypeORM and class-validator decorators need Reflect.getMetadata at module
// load time. The running app gets this from main.ts; tests have no such entry
// point, so it is loaded here before any suite is required. Importing it at
// the top of a single spec is not enough: in a full run another suite can pull
// a decorated module in first, and its decorators then execute too early.
import 'reflect-metadata';
