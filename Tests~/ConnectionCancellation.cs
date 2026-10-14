using System;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using ViewFX.Editor;

public static class ConnectionCancellation
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static void Invoke(ViewFXWindow window, string method) => typeof(ViewFXWindow).GetMethod(method, Private).Invoke(window, null);
    private static object State(ViewFXWindow window) => typeof(ViewFXWindow).GetField("state", Private).GetValue(window);
    private static void Set(object state, string field, string value) => state.GetType().GetField(field).SetValue(state, value);
    private static async Task<T> Within<T>(Task<T> task)
    {
        if (await Task.WhenAny(task, Task.Delay(10000)) != task) throw new Exception("Timed out waiting for HTTP request.");
        return await task;
    }
    private static void Reply(HttpListenerContext request, int status, string body)
    {
        request.Response.StatusCode = status;
        var bytes = Encoding.UTF8.GetBytes(body);
        request.Response.ContentType = "application/json";
        request.Response.OutputStream.Write(bytes, 0, bytes.Length);
        request.Response.Close();
    }
    public static async void Run()
    {
        var listener = new HttpListener();
        ViewFXWindow window = null;
        int exitCode = 1;
        try
        {
            listener.Prefixes.Add("http://localhost:18101/");
            listener.Start();
            window = ScriptableObject.CreateInstance<ViewFXWindow>();
            var state = State(window);
            Set(state, "siteUrl", "http://localhost:18101");
            Set(state, "id", "test-cancel");
            Set(state, "pollToken", "test-secret");
            Set(state, "expiresAt", DateTimeOffset.UtcNow.AddMinutes(5).ToString("O"));
            Invoke(window, "Tick");
            var poll = await Within(listener.GetContextAsync());
            if (!poll.Request.Url.AbsolutePath.EndsWith("/poll")) throw new Exception("Expected poll.");
            // Leave polling unanswered to reproduce a slow server.
            Invoke(window, "Cancel");
            var cancel = await Within(listener.GetContextAsync());
            if (cancel.Request.HttpMethod != "DELETE" || cancel.Request.Headers["Authorization"] != "Bearer test-secret")
                throw new Exception("Cancel did not interrupt polling with an authenticated DELETE.");
            Reply(cancel, 500, "{\"error\":\"Retry cancellation\"}");
            await Task.Delay(500);
            Invoke(window, "Tick");
            if (State(window).GetType().GetField("id").GetValue(State(window)) as string != "test-cancel")
                throw new Exception("Failed cancellation discarded pending state.");
            var nextRequest = listener.GetContextAsync();
            await Task.Delay(3500);
            Invoke(window, "Tick");
            if (nextRequest.IsCompleted) throw new Exception("Polling resumed after cancellation failure.");
            Invoke(window, "Cancel");
            var retry = await Within(nextRequest);
            if (retry.Request.HttpMethod != "DELETE") throw new Exception("Cancellation retry sent a poll.");
            Reply(retry, 200, "{\"status\":\"cancelled\"}");
            await Task.Delay(500);
            Invoke(window, "Tick");
            if (!string.IsNullOrEmpty(State(window).GetType().GetField("id").GetValue(State(window)) as string))
                throw new Exception("Successful cancellation did not clear pending state.");
            Debug.Log("CANCELLATION_TEST_PASSED: interrupted poll, authenticated cancellation, failure retention, paused polling, retry and state cleanup.");
            exitCode = 0;
        }
        catch (Exception error) { Debug.LogException(error); }
        finally
        {
            if (window != null) UnityEngine.Object.DestroyImmediate(window);
            listener.Close();
            EditorApplication.Exit(exitCode);
        }
    }
}
