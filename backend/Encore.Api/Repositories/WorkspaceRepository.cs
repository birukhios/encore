using Encore.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Repositories;

public sealed record LoadedWorkspace(Tenant Row, Workspace Document);

public interface IWorkspaceRepository
{
    Task<LoadedWorkspace?> FindAsync(string tenantId, CancellationToken cancellationToken);

    /// <summary>Saves only if nobody else saved since <paramref name="expectedVersion"/>; returns false when they did.</summary>
    Task<bool> SaveAsync(string tenantId, Workspace document, int expectedVersion, CancellationToken cancellationToken);
}

public sealed class WorkspaceRepository(EncoreDbContext db) : IWorkspaceRepository
{
    public async Task<LoadedWorkspace?> FindAsync(string tenantId, CancellationToken cancellationToken)
    {
        var row = await db.Tenants.AsNoTracking().SingleOrDefaultAsync(t => t.Id == tenantId, cancellationToken);
        return row is null ? null : new LoadedWorkspace(row, Workspace.Parse(row.State));
    }

    public async Task<bool> SaveAsync(string tenantId, Workspace document, int expectedVersion, CancellationToken cancellationToken)
    {
        // The version check and the write are one statement, so two staff members saving at once cannot
        // silently overwrite each other; the loser gets the same 409 the Python server returns.
        var state = document.Serialize();
        var changed = await db.Tenants
            .Where(t => t.Id == tenantId && t.Version == expectedVersion)
            .ExecuteUpdateAsync(set => set
                .SetProperty(t => t.State, state)
                .SetProperty(t => t.Name, document.Name)
                .SetProperty(t => t.Version, t => t.Version + 1), cancellationToken);
        return changed == 1;
    }
}
