//! Own the driver of custom streams as well as the Redis connection.
use redis::aio::ConnectionLike;

pub(super) struct Transport {
    inner: redis::aio::MultiplexedConnection,
    driver: Option<tokio::task::JoinHandle<()>>,
    pub(super) endpoint: Option<super::cluster::RedisEndpoint>,
}

impl Transport {
    pub(super) fn direct(inner: redis::aio::MultiplexedConnection) -> Self {
        Self {
            inner,
            driver: None,
            endpoint: None,
        }
    }

    pub(super) async fn from_stream(
        settings: &redis::RedisConnectionInfo,
        stream: impl redis::aio::AsyncStream + Unpin + Send + 'static,
        config: redis::AsyncConnectionConfig,
    ) -> redis::RedisResult<Self> {
        let (inner, driver) =
            redis::aio::MultiplexedConnection::new_with_config(settings, stream, config).await?;
        Ok(Self {
            inner,
            driver: Some(tokio::spawn(driver)),
            endpoint: None,
        })
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        // Redis's public custom-stream constructor does not install its internal
        // task guard. Abort even when a server has left a command unanswered.
        if let Some(driver) = &self.driver {
            driver.abort();
        }
    }
}

impl ConnectionLike for Transport {
    fn req_packed_command<'a>(
        &'a mut self,
        cmd: &'a redis::Cmd,
    ) -> redis::RedisFuture<'a, redis::Value> {
        self.inner.req_packed_command(cmd)
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        pipeline: &'a redis::Pipeline,
        offset: usize,
        count: usize,
    ) -> redis::RedisFuture<'a, Vec<redis::Value>> {
        self.inner.req_packed_commands(pipeline, offset, count)
    }

    fn get_db(&self) -> i64 {
        self.inner.get_db()
    }
}
