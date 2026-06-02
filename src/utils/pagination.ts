import { BadRequestError } from "./error/app-error";

export type PaginationParams = {
  page: number;
  limit: number;
};

export type PaginatedResponse<T> = {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

export const parsePositiveIntegerQuery = (
  value: unknown,
  field: string,
  fallback: number,
) => {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestError(`${field} must be a positive integer`);
  }

  return parsed;
};

export const parseBooleanQuery = (
  value: unknown,
  field: string,
  fallback = false,
) => {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;

  throw new BadRequestError(`${field} must be true or false`);
};

export const parsePaginationQuery = (
  query: { page?: unknown; limit?: unknown },
  defaults: PaginationParams = { page: 1, limit: 20 },
): PaginationParams => ({
  page: parsePositiveIntegerQuery(query.page, "page", defaults.page),
  limit: parsePositiveIntegerQuery(query.limit, "limit", defaults.limit),
});

export const getPaginationOffset = ({ page, limit }: PaginationParams) =>
  (page - 1) * limit;

export const buildPaginatedResponse = <T>(
  data: T[],
  pagination: PaginationParams & { total: number },
): PaginatedResponse<T> => {
  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return {
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: pagination.total,
      totalPages,
      hasNextPage: pagination.page < totalPages,
      hasPreviousPage: pagination.page > 1,
    },
  };
};
