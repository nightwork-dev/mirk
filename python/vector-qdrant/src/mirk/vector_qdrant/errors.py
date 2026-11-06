"""Collection configuration and migration errors."""


class QdrantCollectionError(ValueError):
    """A collection or legacy migration record does not satisfy the adapter contract."""
