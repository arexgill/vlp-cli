export function attachSecondaryErrors(primaryError, secondaryErrors = [], label = 'Additional failures') {
  const failures = secondaryErrors.filter(Boolean);
  if (!primaryError || failures.length === 0) {
    return primaryError;
  }

  primaryError.secondaryErrors = [
    ...(Array.isArray(primaryError.secondaryErrors) ? primaryError.secondaryErrors : []),
    ...failures,
  ];

  if (primaryError.cause === undefined) {
    primaryError.cause = failures.length === 1 ? failures[0] : new AggregateError(failures, label);
  }

  return primaryError;
}

export function collapseErrors(errors = [], label = 'Operation failed') {
  const failures = errors.filter(Boolean);
  if (failures.length === 0) {
    return null;
  }

  const [primaryError, ...secondaryErrors] = failures;
  return attachSecondaryErrors(primaryError, secondaryErrors, label);
}
