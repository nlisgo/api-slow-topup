import { Array, Effect, pipe, Schema } from 'effect';
import { createHash } from 'crypto';
import { FileSystem, HttpClient } from '@effect/platform';

const apiBasePath = 'https://api.prod.elifesciences.org/reviewed-preprints';

const reviewedPreprintItemCodec = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  published: Schema.String,
  statusDate: Schema.String,
});

export const reviewedPreprintsCodec = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    published: Schema.String,
    statusDate: Schema.String,
    hash: Schema.optional(Schema.String),
  }),
);

const paginatedReviewedPreprintsCodec = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(reviewedPreprintItemCodec),
});

export const reviewedPreprintCodec = reviewedPreprintItemCodec;

const getCachedFilePath = '.cached/reviewed-preprints';

const getCachedListFile = `${getCachedFilePath}.json`;
const getCachedFile = (msid: string) => `${getCachedFilePath}/${msid}.json`;

export const getCachedReviewedPreprints = () => pipe(
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(getCachedListFile)),
  Effect.flatMap((input) => Effect.try({
    try: () => JSON.parse(input),
    catch: (error) => new Error(`Invalid JSON: ${error}`),
  })),
  Effect.catchAll(() => Effect.succeed([])),
  Effect.flatMap(Schema.decodeUnknown(reviewedPreprintsCodec)),
);

const missingIndividualReviewedPreprints = pipe(
  getCachedReviewedPreprints(),
  Effect.map(Array.map(({ id: msid }) => msid)),
  Effect.flatMap((paths) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      Effect.all(
        paths.map((msid) =>
          fs.exists(`${getCachedFilePath}/${msid}.json`)
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
            .pipe(Effect.map((exists) => ({ msid, path: getCachedFile(msid), exists }))),
        )
      )
    )
  ),
  Effect.map((results) => results.filter(({ exists }) => !exists).map(({ msid, path }) => ({ msid, path })))
);

const retrieveIndividualReviewedPreprints = (reviewedPreprints: Array<{ msid: string, path: string }>) => pipe(
  reviewedPreprints.map((reviewedPreprint) =>
    pipe(
      HttpClient.get(`${apiBasePath}/${reviewedPreprint.msid}`),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknown(reviewedPreprintCodec)),
      Effect.map((result) => ({
        ...reviewedPreprint,
        result,
      })),
    ),
  ),
  Effect.all,
  Effect.tap((results) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      Effect.all(
        results.map((r) => fs.writeFileString(r.path, JSON.stringify(r.result, undefined, 2)))
      )
    )
  ),
);

export const retrieveMissingIndividualReviewedPreprints = () => pipe(
  missingIndividualReviewedPreprints,
  Effect.flatMap(retrieveIndividualReviewedPreprints),
);

export const reviewedPreprintsTopUp = ({ limit }: { limit: number }) => pipe(
  getCachedReviewedPreprints(),
  Effect.flatMap((cached) => getReviewedPreprintsTopUp({ limit, offset: cached.length })),
  (topUp) => Effect.all([topUp, getCachedReviewedPreprints()]),
  Effect.map((reviewedPreprints) => reviewedPreprints.flat()),
  Effect.map((reviewedPreprints) => JSON.stringify(reviewedPreprints, undefined, 2)),
  Effect.tap((reviewedPreprints) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(getCachedListFile, reviewedPreprints))),
  Effect.tapErrorCause((cause) => Effect.logError(cause)),
);

const reviewedPreprintsTopUpPath = ({ limit = 10, page = 1 }: { limit?: number, page?: number } = {}): string => `${apiBasePath}?order=asc&page=${page}&per-page=${Math.min(limit, 100)}`;

const getReviewedPreprintsTopUpPage = ({ limit, page = 1 }: { limit: number, page?: number }) => pipe(
  Effect.succeed(reviewedPreprintsTopUpPath({ limit, page })),
  Effect.tap(Effect.log),
  Effect.flatMap(HttpClient.get),
  Effect.flatMap((res) => res.json),
  Effect.flatMap(Schema.decodeUnknown(paginatedReviewedPreprintsCodec)),
  Effect.map((response) => response.items),
  Effect.map(Array.map((item) => ({
    ...item,
    hash: createHash('md5').update(JSON.stringify(item)).digest('hex'),
  }))),
);

export const getReviewedPreprintsTopUp = ({ limit, offset = 0 }: { limit: number, offset?: number }) => pipe(
  offset > 0 ? Math.floor((offset + limit) / limit) : 1,
  (page) => [page, ...((page > 0 && offset % limit > 0) ? [page + 1] : [])],
  Array.map((page) => getReviewedPreprintsTopUpPage({ limit, page })),
  Effect.all,
  Effect.map((pages) => pages.flat()),
  Effect.map((results) => results.slice(offset % limit, (offset % limit) + limit)),
);
