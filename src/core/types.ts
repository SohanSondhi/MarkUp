export type FileEdit = {
  path: string;
  content: string;
};

export type GuardConfig = {
  frontendRoot: string;
  allowedPrefixes: string[];
  denylistPrefixes: string[];
};

export type GuardViolationCode =
  | "PATH_EMPTY"
  | "PATH_TRAVERSAL"
  | "PATH_OUTSIDE_FRONTEND"
  | "PATH_DENYLISTED";

export type GuardViolation = {
  code: GuardViolationCode;
  path: string;
  message: string;
};

export type GuardResult = {
  ok: boolean;
  violations: GuardViolation[];
};
