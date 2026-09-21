import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { useAuth } from "../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const styles = useThemedStyles(createStyles);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={styles.container}>
        <Text style={styles.title}>Bingley Job Management</Text>
        <ThemedFormField
          label="Email"
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <ThemedFormField label="Password" placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.button} onPress={handleSubmit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={styles.buttonText.color as string} /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    flex: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, justifyContent: "center" as const, backgroundColor: tokens.background, padding: 24, gap: 12 },
    title: {
      fontSize: font.title,
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginBottom: 16,
      textAlign: "center" as const,
    },
    button: {
      backgroundColor: tokens.accent,
      borderRadius: 3,
      padding: 14,
      alignItems: "center" as const,
      marginTop: 8,
      boxShadow: `0 0 12px ${tokens.accentGlow}`,
    },
    buttonText: {
      color: tokens.background,
      fontWeight: "700" as const,
      fontSize: font.button,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 0.5,
      textTransform: "uppercase" as const,
    },
    error: { color: tokens.danger, fontFamily: fontFamily.mobileFontFamily },
  };
}
