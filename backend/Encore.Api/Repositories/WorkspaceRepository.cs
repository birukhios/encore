using Encore.Api.Domain;
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

/// <summary>The per-organization workspace documents (tenants table).</summary>
public sealed class WorkspaceRepository(EncoreDbContext db) : IWorkspaceRepository
{
    /// <summary>The workspace, upgraded to the current document shape.</summary>
    public async Task<LoadedWorkspace?> FindAsync(string tenantId, CancellationToken cancellationToken = default)
    {
        var row = await db.Tenants.AsNoTracking().SingleOrDefaultAsync(t => t.Id == tenantId, cancellationToken);
        return row is null ? null : new LoadedWorkspace(row, WorkspaceRules.Upgrade(Workspace.Parse(row.State)));
    }

    public async Task<bool> SaveAsync(string tenantId, Workspace document, int expectedVersion, CancellationToken cancellationToken = default)
    {
        // The version check and the write are one statement, so two staff members saving at once cannot
        // silently overwrite each other; the loser gets a 409 and refreshes.
        var state = document.Serialize();
        var changed = await db.Tenants
            .Where(t => t.Id == tenantId && t.Version == expectedVersion)
            .ExecuteUpdateAsync(set => set
                .SetProperty(t => t.State, state)
                .SetProperty(t => t.Name, document.Name)
                .SetProperty(t => t.Version, t => t.Version + 1), cancellationToken);
        return changed == 1;
    }

    /// <summary>Guest orders write under the request's write lock, which already serializes them.</summary>
    public Task WriteAsync(string tenantId, Workspace document) =>
        db.Tenants.Where(t => t.Id == tenantId).ExecuteUpdateAsync(set => set
            .SetProperty(t => t.State, document.Serialize())
            .SetProperty(t => t.Name, document.Name)
            .SetProperty(t => t.Version, t => t.Version + 1));

    public async Task CreateAsync(string tenantId, Workspace document)
    {
        db.Tenants.Add(new Tenant { Id = tenantId, Name = document.Name, State = document.Serialize(), Created = (int)Ids.Now() });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task<string?> StatusAsync(string tenantId) =>
        db.Tenants.AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.Status).FirstOrDefaultAsync();

    public Task SetStatusAsync(string tenantId, string status, string note) =>
        db.Tenants.Where(t => t.Id == tenantId).ExecuteUpdateAsync(s => s.SetProperty(t => t.Status, status).SetProperty(t => t.StatusNote, note));

    /// <summary>Organizations guests may browse: every workspace that is not suspended, by name.</summary>
    public Task<List<Tenant>> ActiveAsync() =>
        db.Tenants.AsNoTracking().Where(t => t.Status != "suspended").OrderBy(t => t.Name).ToListAsync();

    public Task<List<Tenant>> AllAsync() => db.Tenants.AsNoTracking().OrderBy(t => t.Name).ToListAsync();
}
