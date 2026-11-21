use super::{HostKey, error, key_invalid};
use nsh_core::prelude::JsError;
use ring::{rand::SystemRandom, signature};
use rsa::{
    BoxedUint, RsaPrivateKey,
    pkcs1::{DecodeRsaPrivateKey, EncodeRsaPrivateKey},
    pkcs8::DecodePrivateKey,
    traits::PublicKeyParts,
};
use russh::{
    AgentAuthError, Signer, client,
    keys::{Algorithm, HashAlg, PublicKey, agent::AgentIdentity, ssh_key},
};
use ssh_key::{Mpint, Signature, encoding::Encode, private::RsaKeypair, public::RsaPublicKey};

pub(super) struct RsaLoginKey {
    public_key: PublicKey,
    signer: signature::RsaKeyPair,
}

impl RsaLoginKey {
    pub(super) fn from_openssh(key: &RsaKeypair) -> Result<Self, JsError> {
        if !(2048..=4096).contains(&key.key_size()) {
            return Err(key_invalid());
        }
        let integer = |part: &Mpint| {
            part.as_positive_bytes()
                .map(BoxedUint::from_be_slice_vartime)
                .ok_or_else(key_invalid)
        };
        let public = key.public();
        let private = key.private();
        let parsed = RsaPrivateKey::from_components(
            integer(public.n())?,
            integer(public.e())?,
            integer(private.d())?,
            vec![integer(private.p())?, integer(private.q())?],
        )
        .map_err(|_| key_invalid())?;
        Self::from_key(parsed)
    }

    pub(super) fn from_pem(encoded: &str, passphrase: Option<&str>) -> Result<Self, JsError> {
        let key = match encoded.lines().next() {
            Some("-----BEGIN RSA PRIVATE KEY-----") => {
                RsaPrivateKey::from_pkcs1_pem(encoded).map_err(|_| key_invalid())?
            }
            Some("-----BEGIN ENCRYPTED PRIVATE KEY-----") => {
                RsaPrivateKey::from_pkcs8_encrypted_pem(
                    encoded,
                    passphrase.ok_or_else(key_invalid)?,
                )
                .map_err(|_| key_invalid())?
            }
            _ => RsaPrivateKey::from_pkcs8_pem(encoded).map_err(|_| key_invalid())?,
        };
        Self::from_key(key)
    }

    fn from_key(key: RsaPrivateKey) -> Result<Self, JsError> {
        let public_key = RsaPublicKey::new(
            Mpint::from_positive_bytes(&key.e().to_be_bytes()),
            Mpint::from_positive_bytes(&key.n().to_be_bytes()),
        )
        .map_err(|_| key_invalid())?;
        let der = key.to_pkcs1_der().map_err(|_| key_invalid())?;
        let signer = signature::RsaKeyPair::from_der(der.as_bytes()).map_err(|_| key_invalid())?;
        Ok(Self {
            public_key: PublicKey::new(public_key.into(), ""),
            signer,
        })
    }

    pub(super) async fn authenticate(
        &mut self,
        session: &mut client::Handle<HostKey>,
        username: &str,
    ) -> Result<client::AuthResult, JsError> {
        let auth_failed = || error("SSH_AUTHENTICATION_FAILED", "SSH authentication failed");
        let hash = match session
            .best_supported_rsa_hash()
            .await
            .map_err(|_| auth_failed())?
        {
            Some(Some(hash)) => hash,
            None => HashAlg::Sha256,
            Some(None) => {
                return Err(error(
                    "SSH_RSA_SHA2_REQUIRED",
                    "The SSH gateway does not support RSA with SHA-2 signatures",
                ));
            }
        };
        session
            .authenticate_publickey_with(username, self.public_key.clone(), Some(hash), self)
            .await
            .map_err(|_| auth_failed())
    }
}

impl Signer for RsaLoginKey {
    type Error = AgentAuthError;

    async fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        hash: Option<HashAlg>,
        mut message: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        let invalid = |_| russh::keys::Error::InvalidSignature;
        let padding = match hash {
            Some(HashAlg::Sha256) => &signature::RSA_PKCS1_SHA256,
            Some(HashAlg::Sha512) => &signature::RSA_PKCS1_SHA512,
            _ => return Err(russh::keys::Error::InvalidSignature.into()),
        };
        let mut signature = vec![0; self.signer.public().modulus_len()];
        self.signer
            .sign(padding, &SystemRandom::new(), &message, &mut signature)
            .map_err(invalid)?;
        Signature::new(Algorithm::Rsa { hash }, signature)
            .map_err(russh::keys::Error::from)?
            .encode_prefixed(&mut message)
            .map_err(russh::keys::Error::from)?;
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::redis::ssh::{LoginKey, load_private_key};
    use rsa::{pkcs8::EncodePrivateKey, traits::PrivateKeyParts};
    use ssh_key::{LineEnding, PrivateKey};

    #[tokio::test]
    async fn rsa_login_keys_sign_with_sha2() {
        let key = RsaPrivateKey::new(&mut rand::rng(), 2048).unwrap();
        let mpint = |part: &BoxedUint| Mpint::from_positive_bytes(&part.to_be_bytes());
        let public = RsaPublicKey::new(mpint(key.e()), mpint(key.n())).unwrap();
        let private = ssh_key::private::RsaPrivateKey::new(
            mpint(key.d()),
            mpint(&key.crt_coefficient().unwrap()),
            mpint(&key.primes()[0]),
            mpint(&key.primes()[1]),
        )
        .unwrap();
        let openssh = PrivateKey::new(RsaKeypair::new(public, private).unwrap().into(), "")
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap();
        let pem = key.to_pkcs1_pem(LineEnding::LF).unwrap();
        let pkcs8 = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        for encoded in [openssh.as_str(), pem.as_str(), pkcs8.as_str()] {
            let LoginKey::Rsa(mut key) = load_private_key(encoded, None).unwrap() else {
                panic!("RSA key must use the RSA signer");
            };
            let identity = AgentIdentity::from(key.public_key.clone());
            let data = b"SSH user authentication";
            for (hash, algorithm) in [
                (HashAlg::Sha256, &signature::RSA_PKCS1_2048_8192_SHA256),
                (HashAlg::Sha512, &signature::RSA_PKCS1_2048_8192_SHA512),
            ] {
                let signed = key
                    .auth_sign(&identity, Some(hash), data.to_vec())
                    .await
                    .unwrap();
                assert_eq!(&signed[..data.len()], data);
                let raw = Signature::try_from(&signed[data.len() + 4..]).unwrap();
                assert_eq!(raw.algorithm(), Algorithm::Rsa { hash: Some(hash) });
                signature::UnparsedPublicKey::new(algorithm, key.signer.public().as_ref())
                    .verify(data, raw.as_bytes())
                    .unwrap();
            }
            assert!(key.auth_sign(&identity, None, data.to_vec()).await.is_err());
        }
    }
}
