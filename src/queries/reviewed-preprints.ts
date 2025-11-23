import { Array, Effect, Order, pipe, Schema } from 'effect';
import { createHash } from 'crypto';
import { FileSystem, HttpClient } from '@effect/platform';

const apiBasePath = 'https://api.prod.elifesciences.org/reviewed-preprints';
const getCachedFilePath = '.cached/reviewed-preprints';
const getCachedListFile = `${getCachedFilePath}.json`;
const getCachedListFileNew = `${getCachedFilePath}-new.json`;
const getCachedFile = (msid: string) => `${getCachedFilePath}/${msid}.json`;

const stringifyJson = (data: unknown, formatted: boolean = true) => JSON.stringify(data, undefined, formatted ? 2 : undefined);

const reviewedPreprintItemCodec = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  published: Schema.DateFromString,
  statusDate: Schema.DateFromString,
  hash: Schema.optional(Schema.String),
});

type ReviewedPreprint = Schema.Schema.Type<typeof reviewedPreprintItemCodec>

const reviewedPreprintsCodec = Schema.Array(
  reviewedPreprintItemCodec,
);

type ReviewedPreprints = Schema.Schema.Type<typeof reviewedPreprintsCodec>

const paginatedReviewedPreprintsCodec = Schema.Struct({
  total: Schema.Number,
  items: reviewedPreprintsCodec,
});

const retrieveIndividualReviewedPreprints = (reviewedPreprints: Array<{ msid: string, path: string }>) => pipe(
  reviewedPreprints.map((reviewedPreprint) =>
    pipe(
      HttpClient.get(`${apiBasePath}/${reviewedPreprint.msid}`),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknown(reviewedPreprintItemCodec)),
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
        results.map((r) => fs.writeFileString(r.path, stringifyJson(r.result)))
      )
    )
  ),
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

const getCachedReviewedPreprints = (file?: string) => pipe(
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file ?? getCachedListFile)),
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

const retrieveMissingIndividualReviewedPreprints = () => pipe(
  missingIndividualReviewedPreprints,
  Effect.flatMap(retrieveIndividualReviewedPreprints),
);

const reviewedPreprintsTopUpWrite = ({ limit }: { limit: number }) => pipe(
  getCachedReviewedPreprints(),
  Effect.flatMap((cached) => getReviewedPreprintsTopUp({ limit, offset: cached.length })),
  Effect.map((reviewedPreprints) => stringifyJson(reviewedPreprints)),
  Effect.tap((reviewedPreprints) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(getCachedListFileNew, reviewedPreprints))),
);

const reviewedPreprintsTopUpCombine = () => pipe(
  Effect.all([
    getCachedReviewedPreprints(),
    getCachedReviewedPreprints(getCachedListFileNew),
  ] as const),
  Effect.map(([oldList, newList]): ReviewedPreprints => Array.appendAll(oldList)(newList)),
  Effect.map(Array.dedupeWith((a, b) => a.id === b.id)),
  Effect.map(
    Array.sort(
      Order.reverse(
        Order.mapInput(Order.number, (item) => item.statusDate.getTime()),
      ) as Order.Order<ReviewedPreprint>,
    ),
  ),
  Effect.map((reviewedPreprints) => stringifyJson(reviewedPreprints)),
  Effect.tap((reviewedPreprints) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(getCachedListFile, reviewedPreprints))),
);

const reviewedPreprintsTopUpInvalidate = () => pipe(
  getCachedReviewedPreprints(getCachedListFileNew),
  Effect.map(Array.map(({ id: msid }) => getCachedFile(msid))),
  Effect.flatMap((paths) =>
    Effect.flatMap(
      FileSystem.FileSystem,
      (fs) =>
        Effect.forEach(
          paths,
          (path) => fs.remove(path, { force: true }),
          { discard: true },
        ),
    ),
  ),
);

const reviewedPreprintsTopUpTidyUp = () => Effect.flatMap(
  FileSystem.FileSystem,
  (fs) => fs.remove(getCachedListFileNew, { force: true }),
);

const getReviewedPreprintsTopUp = ({ limit, offset = 0 }: { limit: number, offset?: number }) => pipe(
  offset > 0 ? Math.floor((offset + limit) / limit) : 1,
  (page) => [page, ...((page > 0 && offset % limit > 0) ? [page + 1] : [])],
  Array.map((page) => getReviewedPreprintsTopUpPage({ limit, page })),
  Effect.all,
  Effect.map((pages) => pages.flat()),
  Effect.map((results) => results.slice(offset % limit, (offset % limit) + limit)),
);

const createCacheFolder = () => Effect.flatMap(
  FileSystem.FileSystem,
  (fs) => fs.makeDirectory(getCachedFilePath, { recursive: true }),
);

export const reviewedPreprintsTopUp = ({ limit }: { limit: number }) => pipe(
  createCacheFolder(),
  Effect.flatMap(() => reviewedPreprintsTopUpWrite({ limit })),
  Effect.flatMap(reviewedPreprintsTopUpInvalidate),
  Effect.flatMap(reviewedPreprintsTopUpCombine),
  Effect.flatMap(reviewedPreprintsTopUpTidyUp),
  Effect.flatMap(retrieveMissingIndividualReviewedPreprints),
);
