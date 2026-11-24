using System.Net;
using System.Text;
using System.Text.Json;
using FamilyBudget.Api.Infrastructure.Configuration;
using FamilyBudget.Api.Infrastructure.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

internal static class JobChecks
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    public static async Task Run()
    {
        var clock = new ManualClock(new DateTimeOffset(2030, 1, 1, 16, 59, 59, TimeSpan.Zero));
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new BudgetDb(new DbContextOptionsBuilder<BudgetDb>().UseSqlite(connection).Options, clock);
        await db.Database.EnsureCreatedAsync();
        for (var i = 0; i < 9; i++) db.Households.Add(new Household { Name = $"Batch {i}" });
        await db.SaveChangesAsync();
        var seen = new HashSet<Guid>();
        await foreach (var house in JobPages.Read(db.Households.AsNoTracking(), h => h.Id, 2, default))
        {
            Check(seen.Add(house.Id), "no repeated page item");
            await db.Households.Where(h => h.Id == house.Id).ExecuteDeleteAsync();
        }
        Check(seen.Count == 9 && await db.Households.CountAsync() == 0, "keyset pages do not skip deleted rows");
        using var alreadyCanceled = new CancellationTokenSource(); alreadyCanceled.Cancel();
        var canceled = false;
        try { await foreach (var _ in JobPages.Read(db.Households.AsNoTracking(), h => h.Id, 1, alreadyCanceled.Token)) { } }
        catch (OperationCanceledException) { canceled = true; }
        Check(canceled, "paging honors cancellation");
        db.ChangeTracker.Clear();

        var houseForPush = new Household { Name = "Family", Budget = new SharedBudget() };
        var account = new Account { Email = "member@example.com", NormalizedEmail = "MEMBER@EXAMPLE.COM" };
        db.Households.Add(houseForPush); db.Accounts.Add(account);
        db.Memberships.Add(new HouseholdMembership { AccountId = account.Id, Household = houseForPush, Role = "Member" });
        var subscription = new HouseholdSubscription { HouseholdId = houseForPush.Id, TrialStartedAt = clock.GetUtcNow(), TrialEndsAt = clock.GetUtcNow().AddSeconds(1) };
        db.HouseholdSubscriptions.Add(subscription);
        var job = new BaseCurrencyJob { Id = Guid.NewGuid(), HouseholdId = houseForPush.Id, State = "Completed", FromCurrency = "EUR", ToCurrency = "USD", Rate = 1.2m, RateDate = new DateOnly(2030, 1, 1), RequestedAt = clock.GetUtcNow(), CompletedAt = clock.GetUtcNow() };
        db.BaseCurrencyJobs.Add(job);
        foreach (var device in new[] { "one", "two" }) db.Sessions.Add(new DeviceSession { AccountId = account.Id, TokenHash = device, ExpiresAt = clock.GetUtcNow().AddDays(1), PushToken = $"ExpoPushToken[{device}]" });
        await db.SaveChangesAsync();
        Check(await SubscriptionAccess.CanWrite(db, houseForPush.Id), "trial before exact deadline");
        await CurrencyNotifications.Enqueue(db, job, default); await db.SaveChangesAsync();
        Check(await db.CurrencyPushDeliveries.AllAsync(p => p.RetryAt == clock.GetUtcNow()), "enqueue uses injected clock");
        clock.Advance(TimeSpan.FromSeconds(1));
        Check(!await SubscriptionAccess.CanWrite(db, houseForPush.Id), "trial ends at exact deadline");
        var retention = HouseholdRetentionPolicy.Calculate(subscription, clock.GetUtcNow(), new RetentionOptions { TrialDays = 30 })!;
        Check(retention.DaysUntilDeletion == 30 && DeletionReminders.Stage(retention, clock.GetUtcNow()) == "started", "retention starts at access end");
        var seven = HouseholdRetentionPolicy.Calculate(subscription, retention.DeletionAt.AddDays(-7))!;
        Check(DeletionReminders.Stage(seven, retention.DeletionAt.AddDays(-7)) == "seven-days", "seven-day reminder boundary");
        var one = HouseholdRetentionPolicy.Calculate(subscription, retention.DeletionAt.AddDays(-1))!;
        Check(DeletionReminders.Stage(one, retention.DeletionAt.AddDays(-1)) == "one-day", "one-day reminder boundary");

        var network = new FixtureHandler();
        var delivery = new ReminderDelivery(Options.Create(new ReminderOptions()), new EnvironmentStub(), new ClientFactory(network));
        var processor = new CurrencyNotifications(db, delivery, NullLogger<CurrencyNotifications>.Instance, Options.Create(new CurrencyNotificationOptions { BatchSize = 1 }));
        await processor.Run(default);
        Check(network.Calls == 2, "composite paging visits both devices sharing a notice");
        Check(await db.CurrencyPushDeliveries.CountAsync(p => p.State == "Accepted") == 1, "successful device completes despite failed device");
        clock.Advance(TimeSpan.FromSeconds(59)); await processor.Run(default);
        Check(network.Calls == 2, "retry lease not expired");
        clock.Advance(TimeSpan.FromSeconds(1)); await processor.Run(default);
        Check(network.Calls == 3 && await db.CurrencyPushDeliveries.CountAsync(p => p.State == "Accepted") == 2, "failed delivery recovers at exact retry time");
        // A fresh processor (restart) must not re-send acknowledged deliveries.
        await new CurrencyNotifications(db, delivery, NullLogger<CurrencyNotifications>.Instance, Options.Create(new CurrencyNotificationOptions { BatchSize = 1 })).Run(default);
        Check(network.Calls == 3, "restart preserves delivery completion");

        // Cancellation after a durable claim leaves it pending until the lease expires.
        var secondJob = new BaseCurrencyJob { Id = Guid.NewGuid(), HouseholdId = houseForPush.Id, State = "Completed", FromCurrency = "USD", ToCurrency = "EUR", Rate = .9m, RateDate = new DateOnly(2030, 1, 1), RequestedAt = clock.GetUtcNow(), CompletedAt = clock.GetUtcNow() };
        db.BaseCurrencyJobs.Add(secondJob);
        await db.Sessions.Where(s => s.TokenHash == "two").ExecuteUpdateAsync(set => set.SetProperty(s => s.PushToken, (string?)null));
        await db.SaveChangesAsync();
        await CurrencyNotifications.Enqueue(db, secondJob, default); await db.SaveChangesAsync();
        network.Block = true;
        using (var deliveryStop = new CancellationTokenSource())
        {
            var interrupted = processor.Run(deliveryStop.Token);
            await network.Started.Task.WaitAsync(TimeSpan.FromSeconds(3));
            deliveryStop.Cancel();
            var observed = false;
            try { await interrupted; } catch (OperationCanceledException) { observed = true; }
            Check(observed, "delivery cancellation propagates");
        }
        var attempts = network.Calls;
        network.Block = false;
        await processor.Run(default); Check(network.Calls == attempts, "canceled claim retains lease");
        clock.Advance(TimeSpan.FromSeconds(60)); await processor.Run(default);
        Check(network.Calls == attempts + 1 && !await db.CurrencyPushDeliveries.AnyAsync(p => p.State == "Pending"), "canceled delivery recovers after lease");

        var publicationClock = new ManualClock(new DateTimeOffset(2030, 1, 1, 16, 59, 59, TimeSpan.Zero));
        using (var publicationClient = new HttpClient(new RateHandler()) { BaseAddress = new Uri("https://example.invalid/") })
        {
            var rates = new EcbRates(publicationClient, publicationClock);
            var waited = false;
            try { await rates.Get(new DateOnly(2030, 1, 1), "USD", "EUR", default); }
            catch (InvalidOperationException) { waited = true; }
            Check(waited, "recurring rates wait before UTC publication cutoff");
            publicationClock.Advance(TimeSpan.FromSeconds(1));
            Check((await rates.Get(new DateOnly(2030, 1, 1), "USD", "EUR", default)).Rate == .9m, "rates become available at UTC cutoff");
        }

        var pollClock = new ManualClock(clock.GetUtcNow());
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var stop = new CancellationTokenSource();
        var runs = 0;
        var polling = PeriodicJobs.Run(true, 60, pollClock, _ => { if (++runs == 2) second.TrySetResult(); return Task.CompletedTask; }, NullLogger.Instance, "test", stop.Token);
        Check(runs == 1, "worker starts immediately");
        pollClock.Advance(TimeSpan.FromSeconds(60)); await second.Task.WaitAsync(TimeSpan.FromSeconds(3));
        stop.Cancel(); await polling.WaitAsync(TimeSpan.FromSeconds(3));
        Check(runs == 2, "worker uses injected timer and stops while idle");
        using var activeStop = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var active = PeriodicJobs.Run(true, 60, pollClock, async token => { started.SetResult(); await Task.Delay(Timeout.Infinite, token); }, NullLogger.Instance, "test", activeStop.Token);
        await started.Task; activeStop.Cancel(); await active.WaitAsync(TimeSpan.FromSeconds(3));
        var logs = new LogCollector();
        JobLog.Retry(logs, new HttpRequestException("secret-purchase-token-and-api-key"), "delivery", job.Id);
        Check(!logs.Text.Contains("secret-purchase") && logs.Text.Contains("HttpRequestException") && logs.Text.Contains(job.Id.ToString()), "diagnostics omit provider secrets");
        Console.WriteLine(JsonSerializer.Serialize(new { clockBoundaries = true, paging = true, retryAndRestart = true, cancellation = true, safeDiagnostics = true }));
    }
    private sealed class FixtureHandler : HttpMessageHandler
    {
        public int Calls;
        public bool Block;
        public TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested(); Calls++;
            if (Block) { Started.TrySetResult(); await Task.Delay(Timeout.Infinite, cancellationToken); }
            return new HttpResponseMessage(Calls == 1 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
                { Content = new StringContent("{\"data\":{\"status\":\"ok\",\"id\":\"fixture\"}}", Encoding.UTF8, "application/json") };
        }
    }
    private sealed class RateHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"date\":\"2030-01-01\",\"base\":\"USD\",\"quote\":\"EUR\",\"rate\":0.9}", Encoding.UTF8, "application/json") });
    }
    private sealed class ClientFactory(HttpMessageHandler handler) : IHttpClientFactory { public HttpClient CreateClient(string name) => new(handler, false); }
    private sealed class EnvironmentStub : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "tests";
        public string WebRootPath { get; set; } = "";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
    private sealed class LogCollector : ILogger
    {
        public string Text = "";
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Text += formatter(state, exception);
    }
    private sealed class ManualClock(DateTimeOffset now) : TimeProvider
    {
        private readonly List<ManualTimer> timers = [];
        public override DateTimeOffset GetUtcNow() => now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new ManualTimer(this, callback, state); timers.Add(timer); timer.Change(dueTime, period); return timer;
        }
        public void Advance(TimeSpan duration)
        {
            now += duration;
            foreach (var timer in timers.ToArray()) timer.Tick(now);
        }
        private sealed class ManualTimer(ManualClock owner, TimerCallback callback, object? state) : ITimer
        {
            private DateTimeOffset next = DateTimeOffset.MaxValue;
            private TimeSpan period;
            private bool disposed;
            public bool Change(TimeSpan due, TimeSpan repeat) { if (disposed) return false; period = repeat; next = due == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : owner.GetUtcNow() + due; return true; }
            public void Tick(DateTimeOffset value) { if (disposed || value < next) return; next = period == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : value + period; callback(state); }
            public void Dispose() => disposed = true;
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }
}
