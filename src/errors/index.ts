export class PolyticianError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends PolyticianError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, 'NOT_FOUND');
  }
}

export class ValidationError extends PolyticianError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class ConversionError extends PolyticianError {
  constructor(message: string, from?: string, to?: string) {
    const detail = from && to ? ` (${from} -> ${to})` : '';
    super(`${message}${detail}`, 'CONVERSION_ERROR');
  }
}

export class ConfigurationError extends PolyticianError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

export class VersionConflictError extends PolyticianError {
  public readonly currentVersion: number;

  constructor(id: string, expectedVersion: number, currentVersion: number) {
    super(
      `Version conflict on concept '${id}': expected version ${expectedVersion}, but current version is ${currentVersion}`,
      'VERSION_CONFLICT'
    );
    this.currentVersion = currentVersion;
  }
}

/** The caller may not address this namespace (allowlist, cross-namespace gate, or a namespace move). */
export class NamespaceDeniedError extends PolyticianError {
  constructor(message: string) {
    super(message, 'NAMESPACE_DENIED');
  }
}

/** A derived representation would replace an authored one and `overwrite` was not set. */
export class OverwriteRefusedError extends PolyticianError {
  constructor(id: string, representation: string) {
    super(
      `Concept '${id}' already has an authored ${representation} representation; pass overwrite: true to replace it with derived content`,
      'OVERWRITE_REFUSED'
    );
  }
}
