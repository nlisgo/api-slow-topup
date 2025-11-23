#!/usr/bin/env node
import { NodeContext, NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { CliConfig, Command, Options } from '@effect/cli';
import {
  reviewedPreprintsTopUp
} from '../queries/reviewed-preprints';
import { FetchHttpClient } from '@effect/platform';

const limit = Options.integer('limit')
  .pipe(
    Options.withAlias('l'),
    Options.withSchema(Schema.Int.pipe(Schema.between(1, 100))),
    Options.withDefault(20),
  );

const command = Command.make(
  'top-up-reviewed-preprints',
  { limit },
  ({ limit }) => reviewedPreprintsTopUp({ limit }),
);

const cliApp = Command.run(command, {
  name: 'top-up-reviewed-preprints',
  version: '0.1.0',
});

const AppLayer = [
  NodeFileSystem.layer,
  NodeContext.layer,
  CliConfig.layer({
    showBuiltIns: false,
  }),
  FetchHttpClient.layer,
] as const;

cliApp(process.argv)
  .pipe(
    Effect.provide(AppLayer),
    NodeRuntime.runMain({
      disableErrorReporting: true,
    }),
  );
